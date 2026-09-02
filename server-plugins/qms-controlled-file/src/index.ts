//
// Copyright © 2026 TPP.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  type Doc,
  type MeasureContext,
  type Ref,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxUpdateDoc,
  TxProcessor
} from '@hcengineering/core'
import { plugin, type Plugin } from '@hcengineering/platform'
import documents, { DocumentState } from '@hcengineering/controlled-documents'
import drive, { type File, type FileVersion } from '@hcengineering/drive'
import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'

export const serverQmsControlledFileId = 'server-qms-controlled-file' as Plugin

/**
 * QMS Milestone 5 (PG-018): prevents silently replacing the content of a Drive `File` that is
 * the `controlledFile` of a `ControlledDocument` currently in the `Effective` state — "Rev 04
 * approved, then silently replace the associated DOCX/XLSX while leaving the revision as Rev 04"
 * must never happen. Modeled directly on `server-plugins/rating`'s `RatingMiddleware`: same
 * "inspect incoming `TxCUD` shapes in `tx()`, throw to reject before it's committed" pattern,
 * registered into `server/server-pipeline/src/pipeline.ts` the same way. This is a genuine
 * pre-commit `Middleware`, not a reactive `Trigger` — triggers only run after a tx is already
 * applied and cannot block it (confirmed by reading `foundations/server/packages/middleware/
 * src/spacePermissions.ts`, the other precedent for "reject a tx", which uses the identical
 * `TxApplyIf`-unwrapping approach used below).
 *
 * See docs/qms-extensions.md (Milestone 5) for the full design and rollback instructions.
 */
export class QmsControlledFileLockMiddleware extends BaseMiddleware implements Middleware {
  static async create (ctx: MeasureContext, context: PipelineContext, next?: Middleware): Promise<Middleware> {
    return new QmsControlledFileLockMiddleware(context, next)
  }

  async tx (ctx: MeasureContext, tx: Tx[]): Promise<TxMiddlewareResult> {
    for (const t of tx) {
      await this.checkTx(ctx, t)
    }
    return await this.provideTx(ctx, tx)
  }

  /**
   * Drive's `createFileVersion()` (plugins/drive/src/utils.ts) uploads a new revision as a
   * 2-op batch — create the `FileVersion` + repoint `File.file` at it — sent to the server as
   * a single `TxApplyIf` whenever more than one op is queued (see `ApplyOperations.commit()` in
   * `@hcengineering/core`: `txes.length > 1` always takes the `createTxApplyIf` path).
   *
   * This middleware is registered in the pipeline right after `ApplyTxMiddleware` (see
   * server/server-pipeline/src/pipeline.ts, same position as `RatingMiddleware`), and
   * `ApplyTxMiddleware.tx()` already unwraps every `TxApplyIf` it sees into its individual
   * `.txes` before calling `next.tx()` — so in practice we always receive the flat
   * `TxCreateDoc<FileVersion>` directly, never a wrapping `TxApplyIf`. The branch below is
   * defense-in-depth only (mirrors `SpacePermissionsMiddleware`, which runs *before*
   * `ApplyTxMiddleware` and therefore genuinely needs it) in case pipeline ordering ever
   * changes upstream.
   */
  private async checkTx (ctx: MeasureContext, tx: Tx): Promise<void> {
    if (tx._class === core.class.TxApplyIf) {
      const applyTx = tx as TxApplyIf
      for (const t of applyTx.txes) {
        await this.checkTx(ctx, t)
      }
      return
    }

    if (!TxProcessor.isExtendsCUD(tx._class)) return
    const cud = tx as TxCUD<Doc>

    if (cud._class === core.class.TxCreateDoc && this.context.hierarchy.isDerived(cud.objectClass, drive.class.FileVersion)) {
      // A new FileVersion is always created as an attached doc of its File (see
      // `createTxCollectionCUD` in @hcengineering/core, which sets `attachedTo` on the very tx
      // object itself, not a nested envelope) — this is the Drive File whose content would change.
      const createTx = cud as TxCreateDoc<FileVersion>
      const fileId = createTx.attachedTo as Ref<File> | undefined
      if (fileId === undefined) return
      await this.rejectIfEffective(ctx, fileId, 'uploading a new file version')
      return
    }

    if (cud._class === core.class.TxUpdateDoc && this.context.hierarchy.isDerived(cud.objectClass, drive.class.File)) {
      // `restoreFileVersion()` (plugins/drive/src/utils.ts and plugins/drive-resources/src/
      // utils.ts) repoints `File.file` at an older FileVersion without creating a new one — a
      // second way the "currently displayed content" could silently change out from under an
      // Effective revision, so it needs the same guard as new-version uploads.
      const updateTx = cud as TxUpdateDoc<File>
      if (updateTx.operations.file === undefined) return
      await this.rejectIfEffective(ctx, updateTx.objectId, 'restoring a different file version')
    }
  }

  private async rejectIfEffective (ctx: MeasureContext, fileId: Ref<File>, action: string): Promise<void> {
    // Is this Drive File the controlled content of an Effective ControlledDocument? Note:
    // `controlledFile` is a plain field name on the base `documents.class.Document` query here,
    // even though it's only actually declared on the `ControlledFile` mixin — the Mongo adapter
    // auto-resolves a bare field name to its owning mixin's storage path when the field isn't
    // found on the base class (`checkMixinKey` in
    // foundations/server/packages/mongo/src/storage.ts), so no mixin class ref is needed in the
    // query itself.
    const controllingDocs = await this.findAll(ctx, documents.class.Document, {
      controlledFile: fileId,
      state: DocumentState.Effective
    } as any)

    if (controllingDocs.length > 0) {
      throw new Error(
        `Cannot change the content of this file by ${action}: it is the controlled content of an Effective ` +
          `document (${controllingDocs[0]._id}). Create a new document revision instead.`
      )
    }
  }
}

export default plugin(serverQmsControlledFileId, {})

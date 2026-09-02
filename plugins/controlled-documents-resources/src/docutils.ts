//
// Copyright © 2023 Hardcore Engineering Inc.
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
import { get } from 'svelte/store'
import {
  type AttachedData,
  type Ref,
  type TxOperations,
  generateId,
  type Data,
  type MixinUpdate,
  type Hierarchy,
  type Class,
  type MixinData,
  makeCollabId,
  makeDocCollabId
} from '@hcengineering/core'
import { setPlatformStatus, translate, unknownError } from '@hcengineering/platform'
import { copyMarkup } from '@hcengineering/presentation'
import { themeStore } from '@hcengineering/ui'
import documents, {
  type ControlledDocument,
  type Document,
  type DocumentSpace,
  type DocumentTemplate,
  type DocumentTraining,
  type ControlledDocumentSnapshot,
  type ChangeControl,
  type ProjectDocument,
  type Project,
  DocumentState,
  createChangeControl,
  createControlledDocFromTemplate as controlledDocFromTemplate
} from '@hcengineering/controlled-documents'
import { getCurrentEmployee } from '@hcengineering/contact'
// QMS Milestone 4 (PG-004): base plugin, id-only import — see the carry-forward block below.
import qmsControlledFile, { type ControlledFile } from '@hcengineering/qms-controlled-file'
// QMS Milestone 5 (PG-018): `createFile` to give the new revision its own Drive File — see
// the carry-forward block below for why it can no longer reuse the old revision's File.
import drive, { createFile } from '@hcengineering/drive'
import documentsRes from './plugin'
import { getDocumentVersionString } from './utils'

export async function createControlledDocFromTemplate (
  client: TxOperations,
  templateId: Ref<DocumentTemplate> | undefined,
  documentId: Ref<ControlledDocument>,
  spec: AttachedData<ControlledDocument>,
  space: Ref<DocumentSpace>,
  project: Ref<Project> | undefined,
  parent: Ref<ProjectDocument> | undefined,
  docClass: Ref<Class<ControlledDocument>> = documents.class.ControlledDocument
): Promise<{ seqNumber: number, success: boolean }> {
  const result = await controlledDocFromTemplate(client, templateId, documentId, spec, space, project, parent, docClass)

  if (result.success && templateId !== undefined) {
    const source = makeCollabId(documents.mixin.DocumentTemplate, templateId, 'content')
    const target = makeCollabId(docClass, documentId, 'content')
    try {
      await copyMarkup(source, target)
    } catch (err) {
      await setPlatformStatus(unknownError(err))
      return { ...result, success: false }
    }
  }

  return result
}

export async function createNewDraftForControlledDoc (
  client: TxOperations,
  document: ControlledDocument,
  space: Ref<DocumentSpace>,
  version: { major: number, minor: number },
  project: Ref<Project>,
  newDraftDocId?: Ref<ControlledDocument>
): Promise<{ success: boolean, id: Ref<ControlledDocument> }> {
  const hierarchy = client.getHierarchy()

  newDraftDocId = newDraftDocId ?? generateId()

  const ops = client.apply(document.code)

  const notMatchQuery = {
    ...(document.template != null ? { template: document.template } : { template: { $exists: false } }),
    seqNumber: document.seqNumber,
    state: DocumentState.Draft
  }

  ops.notMatch(documents.class.Document, notMatchQuery)

  // Create new change control for new version
  const newCCId = generateId<ChangeControl>()
  const newCCSpec: Data<ChangeControl> = {
    description: '',
    reason: '',
    impact: '',
    impactedDocuments: []
  }

  await createChangeControl(ops, newCCId, newCCSpec, document.space)

  // TODO: copy labels?
  const docSpec: AttachedData<ControlledDocument> = {
    ...(document.template != null ? { template: document.template } : {}),
    ...(document.category != null ? { category: document.category } : {}),
    ...(document.owner != null ? { owner: document.owner } : {}),
    author: getCurrentEmployee(),
    title: document.title,
    code: document.code,
    prefix: document.prefix,
    seqNumber: document.seqNumber,
    major: version.major,
    minor: version.minor,
    commentSequence: 0,
    abstract: document.abstract ?? '',
    reviewers: document.reviewers,
    approvers: document.approvers,
    externalApprovers: [], // Require manual request for all external approvers for new versions of documents. Automatic carry-on would require to set collaborators to all related documents.
    coAuthors: document.coAuthors,
    reviewInterval: document.reviewInterval,
    changeControl: newCCId,
    requests: 0,
    labels: 0,
    state: DocumentState.Draft,
    plannedEffectiveDate: 0,
    content: document.content
  }

  const meta = await client.findOne(documents.class.ProjectMeta, {
    project,
    meta: document.attachedTo
  })

  if (meta !== undefined) {
    await ops.addCollection(documents.class.ProjectDocument, meta.space, meta._id, meta._class, 'documents', {
      project,
      initial: project,
      document: newDraftDocId
    })
  } else {
    console.error('project meta not found', project)
  }

  await ops.addCollection(
    document._class,
    space,
    document.attachedTo,
    document.attachedToClass,
    document.collection,
    docSpec,
    newDraftDocId
  )

  if (hierarchy.hasMixin(document, documents.mixin.DocumentTemplate)) {
    const template = hierarchy.as<Document, DocumentTemplate>(document, documents.mixin.DocumentTemplate)
    await ops.updateMixin(newDraftDocId, documents.class.Document, space, documents.mixin.DocumentTemplate, {
      sequence: template.sequence,
      docPrefix: template.docPrefix
    })
  }

  // QMS Milestone 4 (PG-004), revised in Milestone 5 (PG-018): carry the linked Drive file
  // forward onto the new revision. Mixin data does not copy automatically to a new document id
  // — without this, creating a new revision from a file-based Controlled Document would
  // silently lose its file link, and the new revision's Controlled File tab would show
  // "no file linked".
  //
  // Milestone 4 originally pointed the new revision at the *same* Drive File as the old one.
  // That breaks once Milestone 5's lock exists: the old revision stays Effective (it only
  // becomes Obsolete when *this* new revision itself later becomes Effective), and Drive's
  // `File.file` "current version" pointer is a single value shared by whichever documents
  // reference that File — so uploading a new version for the new Draft revision would silently
  // change what the still-Effective old revision's File tab displays too, AND would be rejected
  // outright by the Milestone 5 lock (the File is still `controlledFile` of an Effective
  // document). Each revision needs its own File for the two to stay independent, mirroring how
  // Huly's native rich-text documents already work: `docSpec.content` above starts as a *copy*
  // of the old revision's markup (`document.content`), not a shared reference to the same blob.
  //
  // So: give the new revision a brand-new Drive File, in the same Drive/folder as the old one,
  // whose initial FileVersion points at the SAME underlying Blob as the old File's current
  // version (a cheap metadata-only copy, no byte duplication — Blobs are immutable content, so
  // sharing one across two independent FileVersion records is safe to read). The user uploads a
  // real new version into this new File during the new revision's Draft/Review cycle; the old
  // File, and the released revision that still points at it, are never touched.
  if (hierarchy.hasMixin(document, qmsControlledFile.mixin.ControlledFile)) {
    const controlledFile = hierarchy.as<Document, ControlledFile>(document, qmsControlledFile.mixin.ControlledFile)
    const oldFileId = controlledFile.controlledFile
    if (oldFileId != null) {
      const oldFile = await client.findOne(drive.class.File, { _id: oldFileId })
      const oldVersion =
        oldFile !== undefined ? await client.findOne(drive.class.FileVersion, { _id: oldFile.file }) : undefined
      if (oldFile !== undefined && oldVersion !== undefined) {
        const newFileId = await createFile(ops, oldFile.space, oldFile.parent, {
          title: oldVersion.title,
          file: oldVersion.file,
          size: oldVersion.size,
          type: oldVersion.type,
          lastModified: Date.now(),
          metadata: oldVersion.metadata
        })
        await ops.updateMixin(newDraftDocId, documents.class.Document, space, qmsControlledFile.mixin.ControlledFile, {
          controlledFile: newFileId
        })
      }
    }
  }

  const documentTraining = getDocumentTraining(hierarchy, document)
  if (documentTraining !== undefined) {
    const newDraftDoc = await client.findOne(document._class, { _id: newDraftDocId })
    if (newDraftDoc === undefined) {
      console.error(`Document #${newDraftDocId} not found`)
    } else {
      await createDocumentTraining(ops, newDraftDoc, {
        enabled: false,
        roles: documentTraining.roles,
        training: documentTraining.training,
        trainees: documentTraining.trainees,
        maxAttempts: documentTraining.maxAttempts,
        dueDays: documentTraining.dueDays
      })
    }
  }

  const res = await ops.commit()

  return { success: res.result, id: newDraftDocId }
}

export async function createDocumentSnapshotAndEdit (client: TxOperations, document: ControlledDocument): Promise<void> {
  const language = get(themeStore).language
  const namePrefix = await translate(documents.string.DraftRevision, {}, language)
  const name = `${namePrefix} ${(document.snapshots ?? 0) + 1}`
  const newSnapshotId = generateId<ControlledDocumentSnapshot>()

  const op = client.apply(document._id)

  await op.addCollection(
    documents.class.ControlledDocumentSnapshot,
    document.space,
    document._id,
    document._class,
    'snapshots',
    {
      name,
      state: document.state,
      controlledState: document.controlledState,
      content: document.content
    },
    newSnapshotId
  )

  await op.commit()

  await client.update(document, { $unset: { controlledState: true } })

  const source = makeDocCollabId(document, 'content')
  const target = makeCollabId(documents.class.ControlledDocumentSnapshot, newSnapshotId, 'content')
  await copyMarkup(source, target)
}

export function getDocumentTrainingClass (hierarchy: Hierarchy): Class<DocumentTraining> {
  return hierarchy.getClass(documentsRes.mixin.DocumentTraining)
}

export function getDocumentTraining (hierarchy: Hierarchy, document: ControlledDocument): DocumentTraining | undefined {
  return hierarchy.hasMixin(document, documents.mixin.DocumentTraining)
    ? hierarchy.as<Document, DocumentTraining>(document, documents.mixin.DocumentTraining)
    : undefined
}

export async function createDocumentTraining (
  client: TxOperations,
  document: ControlledDocument,
  create: MixinData<Document, DocumentTraining>
): Promise<void> {
  await client.createMixin<Document, DocumentTraining>(
    document._id,
    document._class,
    document.space,
    documents.mixin.DocumentTraining,
    create
  )
}

export async function updateDocumentTraining (
  client: TxOperations,
  document: ControlledDocument,
  update: MixinUpdate<Document, DocumentTraining>
): Promise<void> {
  await client.updateMixin<Document, DocumentTraining>(
    document._id,
    document._class,
    document.space,
    documents.mixin.DocumentTraining,
    update
  )
}

export function getDocReference (doc: Document | null): string {
  if (doc == null) {
    return ''
  }

  return `${doc.code} ${getDocumentVersionString(doc)}`
}

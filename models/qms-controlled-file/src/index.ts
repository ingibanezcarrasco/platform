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

import { type Ref } from '@hcengineering/core'
import { Mixin, Prop, type Builder, TypeRef, UX } from '@hcengineering/model'
import documents, { TDocument } from '@hcengineering/model-controlled-documents'
import drive, { type File } from '@hcengineering/drive'
import { type ControlledFile, qmsControlledFileId } from '@hcengineering/qms-controlled-file'
import qmsControlledFile from './plugin'

export { qmsControlledFileId }
export default qmsControlledFile

// QMS Milestone 3 (PG-003): mixin on the existing documents.class.Document — registered
// from this external package, not from models/controlled-documents (kept untouched), the
// same "data mixin declared by a different plugin than the target class" pattern already
// used in this repo by e.g. models/lead's `@Mixin(lead.mixin.Customer, contact.class.Contact)`.
@Mixin(qmsControlledFile.mixin.ControlledFile, documents.class.Document)
@UX(qmsControlledFile.string.ControlledFile)
export class TControlledFile extends TDocument implements ControlledFile {
  @Prop(TypeRef(drive.class.File), qmsControlledFile.string.ControlledFile, { defaultValue: null })
    controlledFile: Ref<File> | null = null
}

export function createModel (builder: Builder): void {
  builder.createModel(TControlledFile)
}

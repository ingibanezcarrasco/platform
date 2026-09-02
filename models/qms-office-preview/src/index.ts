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

import { type Builder } from '@hcengineering/model'
import core from '@hcengineering/model-core'
import presentation from '@hcengineering/model-presentation'
import { qmsOfficePreviewId } from '@hcengineering/qms-office-preview'
import qmsOfficePreview from './plugin'

export { qmsOfficePreviewId }
export default qmsOfficePreview

// PG-001/PG-002: Office document preview in Huly Drive. Registers a single
// FilePreviewExtension covering DOCX/XLSX/PPTX (+ legacy .doc/.xls/.ppt and
// OpenDocument/RTF equivalents that pod-preview's LibreOffice pipeline already
// recognizes — see pods/preview/src/providers/doc.ts). Purely additive: no
// changes to models/drive, plugins/drive, or their -resources/server packages.
const OFFICE_DOCUMENT_MIME_TYPES = [
  // MS Office (OOXML)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  // MS Office (legacy binary)
  'application/msword', // .doc
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.ms-excel', // .xls
  // OpenDocument
  'application/vnd.oasis.opendocument.text', // .odt
  'application/vnd.oasis.opendocument.presentation', // .odp
  'application/vnd.oasis.opendocument.spreadsheet', // .ods
  // RTF
  'application/rtf',
  'text/rtf'
]

export function createModel (builder: Builder): void {
  builder.createDoc(
    presentation.class.FilePreviewExtension,
    core.space.Model,
    {
      contentType: OFFICE_DOCUMENT_MIME_TYPES,
      alignment: 'float',
      component: qmsOfficePreview.component.OfficePreviewViewer,
      extension: presentation.extension.FilePreviewExtension
    },
    qmsOfficePreview.extension.OfficePreview
  )
}

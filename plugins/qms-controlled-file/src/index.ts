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

import { type Mixin, type Ref } from '@hcengineering/core'
import { type IntlString, plugin, type Plugin } from '@hcengineering/platform'
import { type AnyComponent } from '@hcengineering/ui'
import { type ControlledFile } from './types'

// QMS Milestone 3 (PG-003): "Controlled File" — a mixin letting a Controlled Document
// reference a Drive File as its controlled content, plus a document-panel tab to link,
// preview, download, and see the version history of that file. See
// docs/qms-architecture-analysis.md and docs/qms-extensions.md for the full design.

export * from './types'

export const qmsControlledFileId = 'qms-controlled-file' as Plugin

const qmsControlledFile = plugin(qmsControlledFileId, {
  mixin: {
    ControlledFile: '' as Ref<Mixin<ControlledFile>>
  },
  component: {
    ControlledFileTab: '' as AnyComponent
  },
  string: {
    ControlledFile: '' as IntlString,
    ControlledFileTab: '' as IntlString,
    SelectFile: '' as IntlString,
    ChangeFile: '' as IntlString,
    NoFileLinked: '' as IntlString,
    Download: '' as IntlString,
    FileVersions: '' as IntlString
  }
})

export default qmsControlledFile

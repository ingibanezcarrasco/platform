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

import { type Document } from '@hcengineering/controlled-documents'
import { type File } from '@hcengineering/drive'
import { type Ref } from '@hcengineering/core'

/**
 * QMS Milestone 3 (PG-003): lets a Controlled Document reference a Drive File as its
 * controlled content, for documents that must stay in their native format (e.g. an XLSX
 * scorecard) instead of being converted to Huly-native rich text.
 *
 * A mixin on `documents.class.Document` (not a new top-level class) so every existing
 * Controlled Document/Template already has this field available, defaulting to unset.
 */
export interface ControlledFile extends Document {
  controlledFile: Ref<File> | null
}

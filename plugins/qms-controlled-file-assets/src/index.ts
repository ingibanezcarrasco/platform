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

// Strings only — this milestone introduces no new icons, so unlike e.g.
// plugins/drive-assets there is no loadMetadata(...icon...) call here. The actual
// addStringsLoader(qmsControlledFileId, ...) registration lives in dev/prod/src/platform.ts,
// same as every other plugin's assets package (this file has no side effects of its own to
// import for; it exists so `../lang/*.json` has a package to live in and be resolved from).
export {}

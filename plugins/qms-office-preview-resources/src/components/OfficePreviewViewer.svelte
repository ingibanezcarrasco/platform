<!--
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
-->
<script lang="ts">
  import { type Blob, type Ref, concatLink } from '@hcengineering/core'
  import { getMetadata } from '@hcengineering/platform'
  import presentation, { getCurrentWorkspaceUuid, getFileUrl } from '@hcengineering/presentation'
  import { EmbeddedPDF, Label, Loading } from '@hcengineering/ui'

  // Same prop contract as the built-in view.component.PDFViewer
  // (plugins/view-resources/src/components/viewer/PDFViewer.svelte): FilePreview.svelte
  // renders whatever FilePreviewExtension.component matches with
  // { value: file, name, contentType, metadata, fit, setLoading }.
  export let value: Ref<Blob>
  export let name: string
  export let fit: boolean = false

  let pdfBlob: string | undefined
  let failed = false

  async function resolvePdf (blob: Ref<Blob>): Promise<void> {
    failed = false
    pdfBlob = undefined

    const previewUrl = getMetadata(presentation.metadata.PreviewUrl) ?? ''
    if (previewUrl === '') {
      // pod-preview isn't configured for this deployment — nothing to convert with.
      failed = true
      return
    }

    const token = getMetadata(presentation.metadata.Token) ?? ''
    const workspace = getCurrentWorkspaceUuid()
    const url = concatLink(previewUrl, `/pdf/${encodeURIComponent(workspace)}/${encodeURIComponent(blob)}`)

    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) {
        failed = true
        return
      }
      const json = (await response.json()) as { file: string }
      pdfBlob = json.file
    } catch (err) {
      console.warn('Failed to resolve office document preview', err)
      failed = true
    }
  }

  $: void resolvePdf(value)
</script>

{#if failed}
  <div class="flex-col items-center flex-gap-3">
    <Label label={presentation.string.ContentTypeNotSupported} />
  </div>
{:else if pdfBlob === undefined}
  <Loading />
{:else}
  <EmbeddedPDF src={getFileUrl(pdfBlob, name)} {name} {fit} />
{/if}

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
  import { type Blob as PlatformBlob, type Doc, type Ref, type WithLookup, SortingOrder } from '@hcengineering/core'
  import { type ControlledDocument, type Document } from '@hcengineering/controlled-documents'
  import drive, { type File as DriveFile, type FileVersion } from '@hcengineering/drive'
  import { FilePreview, createQuery, getClient, getFileUrl } from '@hcengineering/presentation'
  import qmsControlledFile, { type ControlledFile } from '@hcengineering/qms-controlled-file'
  import { Button, Label, Scroller, Section } from '@hcengineering/ui'
  import { ObjectSearchBox, Table } from '@hcengineering/view-resources'

  // Injected as a tab into controlled-documents-resources' EditDocPanel.svelte (see the
  // small patch there — no generic extension point exists for panel tabs today, this is
  // the milestone's one CORE-ADJACENT change, documented in docs/qms-extensions.md).
  // controlledDoc/editable are passed explicitly by the panel, same as its own TeamTab.
  export let controlledDoc: ControlledDocument | undefined
  export let editable: boolean = false

  const client = getClient()
  const fileQuery = createQuery()
  const versionQuery = createQuery()

  $: mixinData =
    controlledDoc !== undefined && client.getHierarchy().hasMixin(controlledDoc, qmsControlledFile.mixin.ControlledFile)
      ? client.getHierarchy().as<Document, ControlledFile>(controlledDoc, qmsControlledFile.mixin.ControlledFile)
      : undefined
  $: fileRef = mixinData?.controlledFile ?? null

  let file: DriveFile | undefined
  $: if (fileRef != null) {
    fileQuery.query(drive.class.File, { _id: fileRef }, (res) => {
      file = res[0]
    })
  } else {
    fileQuery.unsubscribe()
    file = undefined
  }

  let version: WithLookup<FileVersion> | undefined
  let blob: Ref<PlatformBlob> | undefined
  let contentType: string | undefined
  $: if (file !== undefined) {
    versionQuery.query(drive.class.FileVersion, { _id: file.file }, (res) => {
      ;[version] = res
      blob = version?.file
      contentType = version?.type
    })
  } else {
    versionQuery.unsubscribe()
    version = undefined
    blob = undefined
    contentType = undefined
  }

  async function linkFile (value: Ref<DriveFile> | null): Promise<void> {
    if (controlledDoc === undefined) return
    const hierarchy = client.getHierarchy()
    if (hierarchy.hasMixin(controlledDoc, qmsControlledFile.mixin.ControlledFile)) {
      await client.updateMixin<Document, ControlledFile>(
        controlledDoc._id,
        controlledDoc._class,
        controlledDoc.space,
        qmsControlledFile.mixin.ControlledFile,
        { controlledFile: value }
      )
    } else {
      await client.createMixin<Document, ControlledFile>(
        controlledDoc._id,
        controlledDoc._class,
        controlledDoc.space,
        qmsControlledFile.mixin.ControlledFile,
        { controlledFile: value }
      )
    }
  }

  function handleChange (ev: CustomEvent<Ref<Doc> | null>): void {
    void linkFile((ev.detail as Ref<DriveFile> | null) ?? null)
  }

  const versionsOptions = {
    lookup: { attachedTo: drive.class.File },
    sort: { version: SortingOrder.Descending }
  }
</script>

<div class="flex-col flex-gap-4 p-4">
  {#if fileRef == null}
    <div class="flex-col flex-gap-2">
      <Label label={qmsControlledFile.string.NoFileLinked} />
      {#if editable}
        <ObjectSearchBox
          _class={drive.class.File}
          value={null}
          label={qmsControlledFile.string.SelectFile}
          on:change={handleChange}
        />
      {/if}
    </div>
  {:else if file !== undefined}
    <div class="flex-between">
      <span class="fs-title">{file.title}</span>
      <div class="flex-row-center flex-gap-2">
        {#if blob !== undefined}
          <a href={getFileUrl(blob, file.title)} download>
            <Button label={qmsControlledFile.string.Download} kind="regular" size="small" />
          </a>
        {/if}
        {#if editable}
          <ObjectSearchBox
            _class={drive.class.File}
            value={fileRef}
            label={qmsControlledFile.string.ChangeFile}
            on:change={handleChange}
          />
        {/if}
      </div>
    </div>

    {#if version !== undefined && blob !== undefined && contentType !== undefined}
      <FilePreview
        file={blob}
        {contentType}
        name={version.title}
        metadata={version.metadata}
        fit={contentType !== 'application/pdf'}
      />
    {/if}

    {#if file.versions > 1}
      <Section label={qmsControlledFile.string.FileVersions}>
        <svelte:fragment slot="content">
          <Scroller horizontal>
            <Table
              _class={drive.class.FileVersion}
              config={['', 'size', 'modifiedOn', 'createdBy']}
              query={{ attachedTo: file._id }}
              readonly={!editable}
              options={versionsOptions}
            />
          </Scroller>
        </svelte:fragment>
      </Section>
    {/if}
  {/if}
</div>

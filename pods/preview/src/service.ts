//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { type Blob, type MeasureContext, type WorkspaceUuid, RateLimiter, withContext } from '@hcengineering/core'
import { type StorageAdapter } from '@hcengineering/server-core'

import { createReadStream } from 'fs'
import { stat as fsStat } from 'fs/promises'

import { type Cache, withCache } from './cache'
import { BadRequestError, NotFoundError } from './error'
import { DocProvider, ImageProvider, FallbackProvider, PdfProvider, VideoProvider, isOfficeDocument } from './providers'
import { TemporaryDir } from './tempdir'
import { type PreviewFile, type PreviewMetadata, type PreviewProvider } from './types'
import { transformImage } from './utils/sharp'
import { SingleFlight } from './singleflight'
import { OctetStreamProvider } from './providers/octet'

export interface OfficePdfResult {
  // Blob name/key under which the converted PDF was persisted in the workspace's
  // own StorageAdapter. Fetchable via the standard front-server `/files` route.
  blobName: string
  cached: boolean
}

export interface ThumbnailParams {
  fit: 'cover' | 'contain'
  format: 'webp' | 'avif' | 'jpeg' | 'png'
  height: number | undefined
  width: number | undefined
}

export interface PreviewService {
  metadata: (ctx: MeasureContext, workspace: WorkspaceUuid, name: string) => Promise<PreviewMetadata>
  thumbnail: (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    name: string,
    params: ThumbnailParams
  ) => Promise<PreviewFile>
  // Converts an Office document (docx/xlsx/pptx/...) to a full PDF and persists it as a
  // derived blob in the workspace's own storage, keyed off the source blob id — so it is
  // revision-safe by construction (every FileVersion already owns a distinct blob id) and
  // durable across pod restarts/replicas, unlike the thumbnail LRU cache above.
  officePdf: (ctx: MeasureContext, workspace: WorkspaceUuid, name: string) => Promise<OfficePdfResult>
}

export function createPreviewService (
  storage: StorageAdapter,
  cache: Cache,
  tempDir: TemporaryDir,
  concurrency: number = 10
): PreviewService {
  const imageProvider = new ImageProvider(storage, tempDir)
  const docProvider = new DocProvider(storage, tempDir)
  const providers: PreviewProvider[] = [
    imageProvider,
    docProvider,
    new PdfProvider(storage, tempDir),
    new VideoProvider(storage, tempDir),
    new OctetStreamProvider(storage, tempDir),
    new FallbackProvider(imageProvider)
  ]
  return new PreviewServiceImpl(storage, cache, tempDir, providers, docProvider, concurrency)
}

class PreviewServiceImpl implements PreviewService {
  private readonly limiter: RateLimiter
  private readonly single: SingleFlight<PreviewFile>
  private readonly singleOfficePdf: SingleFlight<OfficePdfResult>

  constructor (
    private readonly storage: StorageAdapter,
    private readonly cache: Cache,
    private readonly tempDir: TemporaryDir,
    private readonly providers: PreviewProvider[],
    private readonly docProvider: DocProvider,
    concurrency: number = 10
  ) {
    this.single = new SingleFlight<PreviewFile>()
    this.singleOfficePdf = new SingleFlight<OfficePdfResult>()
    this.limiter = new RateLimiter(concurrency)
  }

  @withContext('metadata')
  async metadata (ctx: MeasureContext, workspace: WorkspaceUuid, name: string): Promise<PreviewMetadata> {
    const stat = await this.statBlob(ctx, workspace, name)
    const provider = this.findProvider(ctx, stat.contentType)

    return await ctx.with(
      'metadata',
      { contentType: stat.contentType },
      (ctx) => {
        return provider.metadata(ctx, workspace, name, stat.contentType)
      },
      { workspace }
    )
  }

  async thumbnail (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    name: string,
    params: ThumbnailParams
  ): Promise<PreviewFile> {
    const imageKey = this.imageKey(workspace, name)
    const thumbKey = this.thumbnailKey(workspace, name, params)

    return await this.single.execute(thumbKey, () => {
      return withCache(ctx, this.cache, thumbKey, async () => {
        const stat = await this.statBlob(ctx, workspace, name)
        const provider = this.findProvider(ctx, stat.contentType)

        const image = await withCache(ctx, this.cache, imageKey, () => {
          return ctx.with(
            'thumbnail',
            { contentType: stat.contentType },
            (ctx) => this.limiter.exec(() => provider.image(ctx, workspace, name, stat.contentType)),
            { workspace }
          )
        })

        const thumbPath = this.tempDir.tmpFile()
        const { contentType } = await ctx.with('transformImage', { format: params.format }, () =>
          transformImage(image.filePath, thumbPath, params)
        )

        return {
          filePath: thumbPath,
          mimeType: contentType
        }
      })
    })
  }

  async officePdf (ctx: MeasureContext, workspace: WorkspaceUuid, name: string): Promise<OfficePdfResult> {
    const wsId = { uuid: workspace } as any
    const pdfKey = this.officePdfKey(name)

    return await this.singleOfficePdf.execute(pdfKey, async () => {
      // Cache hit: a previous conversion of this exact source blob is already persisted.
      // Revision-safe by construction — `name` is the source FileVersion's blob id, which is
      // unique per version (see plugins/drive `createFileVersion`), so a new revision always
      // uploads under a different `name` and therefore a different `pdfKey`. No explicit
      // invalidation is needed.
      const existing = await this.storage.stat(ctx, wsId, pdfKey)
      if (existing !== undefined && existing.size > 0) {
        return { blobName: pdfKey, cached: true }
      }

      const stat = await this.statBlob(ctx, workspace, name)
      if (!isOfficeDocument(stat.contentType)) {
        throw new BadRequestError(`Unsupported content type: ${stat.contentType}`)
      }

      const { filePath, mimeType } = await ctx.with('office-pdf', { contentType: stat.contentType }, (ctx) =>
        this.limiter.exec(() => this.docProvider.pdf(ctx, workspace, name, stat.contentType))
      )

      try {
        const fileStat = await fsStat(filePath)
        await ctx.with('office-pdf-upload', {}, async () => {
          await this.storage.put(ctx, wsId, pdfKey, createReadStream(filePath), mimeType, fileStat.size)
        })
      } finally {
        this.tempDir.rm(filePath)
      }

      return { blobName: pdfKey, cached: false }
    })
  }

  private officePdfKey (name: string): string {
    // Mirrors the `${uuid}%preview%${size}${format}` derived-blob naming already used by
    // server/front's getGeneratePreview, so it's an established, collision-safe convention
    // for "derived artifact of blob X" within the same bucket/workspace.
    return `${name}%office-pdf%`
  }

  @withContext('stat-blob')
  async statBlob (ctx: MeasureContext, workspace: WorkspaceUuid, name: string): Promise<Blob> {
    const wsId = { uuid: workspace } as any

    const stat = await this.storage.stat(ctx, wsId, name)
    if (stat !== undefined) {
      return stat
    }

    throw new NotFoundError()
  }

  findProvider (ctx: MeasureContext, contentType: string): PreviewProvider {
    const provider = this.providers.find((it) => it.supports(contentType))
    if (provider != null) {
      return provider
    }

    throw new BadRequestError(`Unsupported content type: ${contentType}`)
  }

  private imageKey (workspaceId: string, name: string): string {
    return `image/${workspaceId}/${name}`
  }

  private thumbnailKey (workspaceId: string, name: string, params: ThumbnailParams): string {
    return `thumbnail/${workspaceId}/${name}-${params.width}-${params.height}-${params.format}`
  }
}

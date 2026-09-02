# QMS Extensions Log

Tracks every change made on `custom/qms-tpp` relative to upstream `develop`, classified per PG-020
as **CONFIGURATION**, **PLUGIN/EXTENSION**, **NEW SERVICE**, or **CORE PATCH**. One section per
milestone. Goal: rebase cleanly onto future Huly releases, and know exactly what to revert if a
change needs to be backed out.

---

## Milestone 2 — Office preview MVP (PG-001 / PG-002)

**Classification: PLUGIN/EXTENSION** (new packages registering against existing extension points)
**+ minor additive change to an existing service** (`pods/preview`, new endpoint/method only —
no existing route, method signature, or behavior was modified).

**No CORE PATCH.** Nothing under `models/drive`, `plugins/drive`, `plugins/controlled-documents`,
or their `-resources`/server counterparts was touched, per the milestone's hard constraint.

### What this milestone does

Inline preview of Office documents (DOCX/XLSX/PPTX, plus legacy `.doc/.xls/.ppt` and
OpenDocument/RTF equivalents) when viewing a file in Huly Drive, by converting the source
document to PDF (reusing `pods/preview`'s existing LibreOffice-headless pipeline) and handing the
result to the platform's existing PDF viewer machinery (`EmbeddedPDF`).

### Changed/new modules

| Module | Change | Classification |
|---|---|---|
| `pods/preview/src/providers/doc.ts` | Added `isOfficeDocument()` export and a `DocProvider.pdf()` method that converts to a full PDF (unlike `image()`, which further reduces to a single-page PNG thumbnail and discards the PDF). Reuses the existing `docToPdf` LibreOffice call — no new conversion logic. | PLUGIN/EXTENSION (additive method on existing class) |
| `pods/preview/src/providers/index.ts` | Export `isOfficeDocument`. | PLUGIN/EXTENSION |
| `pods/preview/src/service.ts` | Added `officePdf()` to the `PreviewService` interface/impl. Converts-or-returns-cached, persists the PDF into the workspace's own `StorageAdapter` (not the pod's local disk LRU cache used by `thumbnail()`). Added a dedicated `SingleFlight` instance to dedupe concurrent conversions of the same source blob. `createPreviewService` now also constructs and threads through a standalone `DocProvider` reference. | PLUGIN/EXTENSION (additive method + constructor param; existing methods/behavior unchanged) |
| `pods/preview/src/server.ts` | Added `GET /pdf/:workspace/:name` route, same `withAuthorization`/`withBlob` middleware as the existing `/metadata` and `/image` routes. Returns `{ file: <blobName>, cached: boolean }` — a *reference*, not the PDF bytes; the client fetches the actual bytes through the standard front-server `/files` route. | PLUGIN/EXTENSION |
| `plugins/qms-office-preview` (new package) | Plugin id declarations only: one `component` id (`OfficePreviewViewer`) and one `extension` id (`OfficePreview`, a `Ref<FilePreviewExtension>`). No logic. | PLUGIN/EXTENSION |
| `plugins/qms-office-preview-resources` (new package) | `OfficePreviewViewer.svelte` — resolves the converted-PDF blob from `pod-preview`'s new `/pdf` endpoint (frontend → pod-preview direct call, see below) and renders it via the existing `EmbeddedPDF` component. Mirrors `plugins/view-resources/src/components/viewer/PDFViewer.svelte`'s prop contract (`value`, `name`, `fit`) so it's a drop-in `FilePreviewExtension.component`. | PLUGIN/EXTENSION |
| `models/qms-office-preview` (new package) | `createModel()` registers a single `presentation.class.FilePreviewExtension` doc covering the Office MIME types, pointing at `OfficePreviewViewer`. Exact same registration mechanism as the built-in PDF/video/text viewers in `models/view/src/index.ts:760-793` — no core model file was edited to add it. | PLUGIN/EXTENSION |
| `models/all/src/index.ts`, `models/all/package.json` | Added the import and one `[qmsOfficePreviewModel, qmsOfficePreviewId]` entry to the existing `builders` array (no `ConfigurablePlugin` config object — always-active, hidden from the Settings app toggle list, same pattern as `[presenceModel, presenceId]`). | CONFIGURATION (one array entry, established aggregation mechanism) |
| `rush.json` | Three new project entries (`qms-office-preview`, `qms-office-preview-resources`, `model-qms-office-preview`), same shape as the neighboring `drive`/`drive-resources`/`model-drive` entries. | CONFIGURATION |

### Frontend → pod-preview: direct call, no new server-plugins package

Resolved the architecture doc's open question by reading `packages/presentation/src/preview.ts`:
the frontend **already** calls `pod-preview` directly for `/metadata` (see `getPreviewMetadata`),
using `presentation.metadata.PreviewUrl` + `presentation.metadata.Token` (a bearer token) — no
server-side proxy in the loop. `OfficePreviewViewer.svelte` follows the exact same pattern for the
new `/pdf` endpoint. A `server-plugins/*` package would have added a hop and a new package for no
functional benefit; `pods/preview`'s own `withAuthorization`/`withBlob` middleware already enforces
the caller holds a valid token scoped to the requested workspace.

### Cache-key scheme (revision-safety)

```
pdfKey = "${sourceBlobId}%office-pdf%"
```

`sourceBlobId` is `FileVersion.file` (a `Ref<Blob>`) — per the Drive architecture analysis
(§2/§3 of `docs/qms-architecture-analysis.md`), Drive **never overwrites a blob**: uploading a new
revision (`createFileVersion`) always creates a new `FileVersion` pointing at a new blob id, never
reuses an old one. Because the cache key is deterministically derived from that source blob id
alone, it is revision-safe *by construction* — a new revision automatically gets a new `pdfKey` and
therefore a fresh conversion, with zero explicit invalidation logic. This mirrors the naming
convention `server/front`'s `getGeneratePreview` already uses for image thumbnails
(`"${uuid}%preview%${size}${format}"`), so it's a consistent, established convention for "derived
artifact of blob X" within the same storage bucket.

Old PDF conversions for superseded revisions are never explicitly deleted (matching `FileVersion`
blobs themselves, which are also retained until the `FileVersion` doc is deleted — see
`OnFileVersionDelete` in `server-plugins/drive-resources`). This is intentional for Milestone 2;
revisiting storage growth is a possible follow-up, not required for the MVP.

### Docker / env changes

**None required.** Contrary to the Milestone 1 architecture doc's note that `PreviewUrl` "isn't
configured in `dev/.env` today," it turns out to already be fully wired for local dev:
`dev/docker-compose.yaml` already defines the `preview` service (port 4040) and already sets
`PREVIEW_URL=http://huly.local:4040` on the `front` service; `dev/prod/public/config.json` already
propagates it to `presentation.metadata.PreviewUrl` at runtime. The new `/pdf` endpoint is just a
new route on that same existing Express app/container — reachable automatically once the `preview`
image is rebuilt from source.

### Rollback

To fully back out Milestone 2:
1. `git revert` the commit(s) listed below (or `git reset` to the commit before this milestone,
   if no other work has landed on top).
2. Remove the three `rush.json` project entries if not using `git revert` for that file.
3. No data migration exists to reverse — this milestone created no new document classes, only a
   `FilePreviewExtension` registration doc (harmless to leave orphaned, but `git revert` removes
   its registration cleanly) and cached PDF blobs under the `%office-pdf%` key suffix in blob
   storage (safe to leave; harmless, un-referenced once the extension is unregistered).
4. Rebuild/redeploy `pod-preview` from the reverted source so the `/pdf` route disappears again.

Commits: see `git log` on `custom/qms-tpp` for this milestone's commit hashes (recorded at merge
time by whoever integrates this branch).

### Manual verification steps (not run by the implementing agent — see AGENTS.md)

1. `rush install` — no new third-party dependencies were added (the new packages only depend on
   existing workspace packages), but this keeps the pnpm lockfile/symlinks consistent for the 3
   new project entries.
2. `rush build` — compiles the new/changed packages; will surface any TypeScript error in the code
   above (it was hand-verified against the actual current source of every file it touches or
   depends on, but not compiled).
3. `rush bundle` then `rush docker:build` — rebuilds `hardcoreeng/preview` (now including the
   `/pdf` route) and bundles the new frontend packages into the webapp build.
4. `docker compose -f dev/docker-compose.yaml up -d --force-recreate` (from `dev/`) — recreates the
   `preview` and `front` containers with the new code.
5. In the running app: open **Drive**, upload a `.docx` (or `.xlsx`/`.pptx`) file, click it to open
   the file panel. Expected: instead of "content type not supported / download only," it shows a
   loading spinner briefly, then the rendered PDF conversion inline via the existing PDF viewer
   chrome. Uploading a **new version** of the same file and reopening should show the updated
   content (not a stale cached preview) — this is the concrete test of the cache-key revision
   safety above.
6. Check `docker compose logs -f preview` during the first open of a given file to confirm the
   LibreOffice conversion path is exercised once, and NOT re-exercised on a second open of the same
   revision (cache hit, `cached: true` in the JSON response — can be observed via browser dev tools
   Network tab on the `/pdf/...` request).

### Follow-up decisions flagged, not made unilaterally

- **Storage growth**: superseded revisions' cached PDFs are never garbage-collected (see above).
  Fine for a pilot; needs a decision before production use (e.g. a periodic sweep keyed off
  `FileVersion` deletion, or accept it as a small permanent cost since Office files/PDFs are
  small relative to the video/image content Drive also stores).
- **Server-side MIME verification**: still not implemented (this was flagged as an open question
  in Milestone 1 and intentionally deferred there too). If a `.docx` gets uploaded with a wrong/
  missing `Content-Type`, `officePdf()` will reject it as "Unsupported content type" instead of
  converting — a silent-looking failure from the user's point of view. Revisit if this becomes a
  real pilot pain point.
- **PDF conversion of a file already in Draft/mid-edit**: this milestone only handles *preview*,
  not lifecycle. PG-003/PG-004 (Milestone 3/4) will need to decide whether an in-progress Draft
  file's preview should ever be treated as "the effective content" — not a concern yet since no
  lifecycle/lock exists on Drive files at this point.

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

### Bug found and fixed during Milestone 3 review

`dev/prod/src/platform.ts` (and its desktop-app counterpart, `desktop/src/ui/platform.ts` —
see the Milestone 3 section below) is where every plugin's `-resources` package gets wired up
via `addLocation(pluginId, () => import('...-resources'))`, so the platform knows which webpack
chunk to dynamically load a component from. Milestone 2 registered `qmsOfficePreview.component.
OfficePreviewViewer` as a `FilePreviewExtension`, but never added the corresponding
`addLocation` call (or the `dev/prod/package.json` dependency) — so the extension doc existed
in the model, but the platform had no way to resolve its component at runtime. The Office
preview would have silently never rendered (Drive would fall back to "no preview"). Fixed as
part of the Milestone 3 commits (`dev/prod` wiring commit) — no model/plugin code changed, only
the two missing wiring lines were added. **Lesson for future milestones**: adding a plugin that
ships a `-resources` package always needs a matching `addLocation` (+ `addStringsLoader` if it
has strings) in `dev/prod/src/platform.ts`, plus the corresponding `dev/prod/package.json`
dependency — easy to miss because nothing fails at compile time, it just silently never loads.

---

## Milestone 3 — Controlled File (PG-003)

**Classification: PLUGIN/EXTENSION** (new packages, mixin registered from an external
package) **+ one minimal CORE-ADJACENT patch** (see below — no extension point exists for
injecting a new tab into the Controlled Document panel today).

**No CORE PATCH to the data/model layer.** Nothing under `models/drive`, `plugins/drive`,
`models/controlled-documents`, or `plugins/controlled-documents` was touched. The one file
touched outside this milestone's own new packages is `plugins/controlled-documents-resources/
src/components/EditDocPanel.svelte` — a UI composition file, not the document model — and the
change there is a single array entry (see below).

### What this milestone does

Lets a Controlled Document reference an existing Drive `File` as its controlled content, for
documents that must stay in their native file format (e.g. an XLSX scorecard) instead of being
converted to Huly-native rich text, per the PG-003 brief (`S7-FM-003 Supplier Scorecard.xlsx`
example). Adds a "File" tab to the document panel showing: the linked file's name, a download
link, inline preview (via the standard `FilePreview` extension mechanism — Milestone 2's Office
viewer applies automatically, no new preview code needed here), and version history. An
`ObjectSearchBox` picker lets an owner link or change the file.

### Changed/new modules

| Module | Change | Classification |
|---|---|---|
| `plugins/qms-controlled-file` (new) | Id-only base plugin: `mixin.ControlledFile` (`Ref<Mixin<ControlledFile>>`), `component.ControlledFileTab`, and `string.*` ids. `types.ts` defines `ControlledFile extends Document { controlledFile: Ref<drive.File> \| null }`. | PLUGIN/EXTENSION |
| `plugins/qms-controlled-file-assets` (new) | `addStringsLoader`-only assets package (no icons this milestone), `lang/en.json` + `lang/ru.json`. | PLUGIN/EXTENSION |
| `plugins/qms-controlled-file-resources` (new) | `ControlledFileTab.svelte` — the tab's UI. Reads the mixin via `hierarchy.hasMixin`/`hierarchy.as` (same pattern as `controlled-documents`' own `DocumentTraining` mixin access in `docutils.ts`); writes it via `client.createMixin`/`updateMixin`. Reuses `FilePreview` (presentation) for inline preview and closely mirrors (not imports — that component isn't publicly exported) `drive-resources`' `EditFileVersions.svelte` `Table`-based version-history pattern. File picking reuses the generic `ObjectSearchBox` from `view-resources` — no new picker UI. | PLUGIN/EXTENSION |
| `models/qms-controlled-file` (new) | `TControlledFile extends TDocument` decorated `@Mixin(qmsControlledFile.mixin.ControlledFile, documents.class.Document)` — registered from this external package, not from `models/controlled-documents`. Same "cross-plugin data mixin" pattern this codebase already uses for `models/lead`'s `@Mixin(lead.mixin.Customer, contact.class.Contact)`. One field: `controlledFile: Ref<drive.class.File> \| null`. | PLUGIN/EXTENSION |
| `plugins/controlled-documents-resources/src/components/EditDocPanel.svelte` | One new entry appended to the existing (already hardcoded, not extension-point-driven) `tabs` array, plus one id-only import. ~10 lines. | **CORE-ADJACENT** (smallest patch found — see below) |
| `plugins/controlled-documents-resources/package.json` | One new dependency: `@hcengineering/qms-controlled-file` (id-only package, no reverse dependency). | CONFIGURATION |
| `rush.json`, `models/all/{package.json,src/index.ts}` | Same wiring pattern as Milestone 2 — 4 new project entries; `[qmsControlledFileModel, qmsControlledFileId]` added to the builders array, positioned after both `driveModel` and `documentsModel` (it depends on both being registered first). | CONFIGURATION |
| `dev/prod/{package.json,src/platform.ts}`, `desktop/src/ui/platform.ts` *(not yet — see follow-up)* | `addLocation`/`addStringsLoader` wiring for the new plugin, in the same commit as the Milestone 2 fix above. | CONFIGURATION |

### Why no panel extension point exists (and why the patch is safe)

Investigated `EditDocPanel.svelte`'s tab system before patching anything: `tabs` is a plain
hardcoded array (`Content`, `Reason & Impact`, `Team`, `Release`, `History`) built in a single
`$: tabs = [...]` reactive block, rendered by `<Tabs model={tabs} .../>` from `@hcengineering/
ui`. There is no `ComponentExtension`/mixin-driven registration for panel tabs (unlike Drive's
`FilePreviewExtension`, which Milestone 2 used). `Tabs.svelte` itself already resolves a tab's
`component` dynamically when it's a string (`{#if typeof tab.component === 'string'}<Component
is={tab.component} .../>`), so the patch only needs an id-only import (`@hcengineering/
qms-controlled-file`, no logic, no heavy transitive deps) — `controlled-documents-resources`
gains zero hard dependency on the package that actually implements the tab
(`qms-controlled-file-resources`).

### Data-model design (why the mixin is safe)

`controlledFile: Ref<drive.class.File> | null` lives as a mixin on `documents.class.Document`
(the base class, not `ControlledDocument` specifically) — so it's available on every revision,
including templates, consistent with how `DocumentTraining` is already scoped in the shipped
product. It is optional/nullable and defaults unset, so every existing Controlled Document is
unaffected until an owner explicitly links a file via the new tab. No migration is needed:
mixin data is additive per-document and only appears once `createMixin` is called for that
specific document.

**Not in scope for this milestone** (explicitly deferred to Milestone 4 per the brief):
nothing prevents replacing the linked file's content after the Controlled Document has reached
Effective, and there's no reverse link shown on the Drive `File` side ("which Controlled
Document controls this file?"). Both are flagged below.

### Docker / env changes

None required — same conclusion as Milestone 2; no new services, only new webpack chunks
resolved through the existing front server.

### Rollback

1. `git revert` the commit(s) for this milestone (see hashes in `git log` on `custom/qms-tpp`).
2. If not using `git revert` for `rush.json`/`models/all`, manually remove the 4 new project
   entries and the `[qmsControlledFileModel, qmsControlledFileId]` array line.
3. Revert the one-line `tabs` array addition and the id-only import in `EditDocPanel.svelte`
   (or let `git revert` handle it — it's a self-contained hunk).
4. Data: any `ControlledFile` mixin data left in the database becomes orphaned but harmless
   (it's just extra fields on existing `Document` records that nothing reads once the mixin
   registration is gone) — no destructive migration needed to roll back.

### Manual verification steps (not run — see AGENTS.md)

1. `rush install` — new project entries, no new third-party deps.
2. `rush build` — compiles the new packages and the two touched files above.
3. `rush bundle` — the new `-resources` packages must now actually produce a webpack chunk
   (this is the thing Milestone 2 silently failed to do — verify chunk names
   `qms-office-preview` and `qms-controlled-file` appear in the bundle output).
4. `docker compose -f dev/docker-compose.yaml up -d --force-recreate` (front only needs
   rebuilding; no backend service changed this milestone).
5. In the running app: open a Controlled Document (or create a new QMS document), go to the new
   **File** tab. Expected: "No file linked" + a "Select file" button (owner only). Pick an
   existing Drive file (e.g. upload `supplier-scorecard.xlsx` to Drive first) — the tab should
   then show the file name, a working Download link, an inline preview (Office files render via
   Milestone 2's viewer automatically), and — if the file has more than one version — a version
   history table.
6. Confirm a non-owner sees the same info read-only (no "Select/Change file" button, version
   table's restore action disabled).

### Follow-up decisions flagged, not made unilaterally

- **Desktop app parity**: `desktop/src/ui/platform.ts` has the same `addLocation`/
  `addStringsLoader` wiring pattern as `dev/prod/src/platform.ts` but was **not** patched in
  this milestone — TPP's actual deployment is self-hosted web (per the Authentik/OIDC runbook),
  not the Electron desktop client, so this was scoped out rather than blindly duplicated. If
  the desktop app is ever used for this QMS, both `qms-office-preview` (Milestone 2) and
  `qms-controlled-file` need the same wiring added there.
- **Reverse link (Drive File → Controlled Document)**: not implemented. A user browsing Drive
  directly has no indication a given file is under document control. Worth a small addition
  (e.g. a badge in `FilePresenter`) once it's clear this is actually needed day-to-day, but it
  would require touching `drive-resources` (or a further mixin + extension point there) —
  deliberately deferred to avoid scope creep on this milestone.
- **`ru.json` is an untranslated duplicate of `en.json`**: added only to satisfy the repo's
  `makeLocalesTest` (`langs = ['en', 'ru']`), not because Russian is actually needed for TPP.
  Real translation (or removing the Russian requirement for internal-only QMS packages) is a
  follow-up if this is ever more broadly deployed.
- **No lifecycle/locking yet** (by design — that's Milestone 4/PG-004/PG-018): a file can still
  be replaced in Drive directly, or relinked to a different file, at any document state
  including Effective. Milestone 4 needs to close this gap.

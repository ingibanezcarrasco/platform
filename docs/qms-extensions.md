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

---

## Milestone 4 — Lifecycle integration (PG-004)

**Classification: mostly VERIFICATION (no change needed) + two small PLUGIN/EXTENSION-adjacent
fixes.** No new packages this milestone.

**Scope note:** the brief's Milestone 4 text ("Apply Draft→Review→Approval→Effective→Obsolete...")
overlaps with Milestone 5 ("Revision protection... prevent released content from being silently
modified"), but the brief's own DEVELOPMENT ORDER keeps them separate. **This milestone does NOT
add any enforcement/locking that blocks replacing a linked file on an Effective document** — that
is Milestone 5. Do not read the absence of locking below as an oversight.

### What was verified, not changed

Because Milestone 3 put the `ControlledFile` mixin directly on `documents.class.Document` (not a
separate entity), a file-based Controlled Document *is* an ordinary `ControlledDocument` with an
extra field — so TraceX's existing review/approval workflow already operates on it correctly, with
zero special-casing. Confirmed by reading current source, not assumed:

- `canSendForReview` (`plugins/controlled-documents-resources/src/stores/editors/document/canSendForReview.ts`)
  and `canSendForApproval` (same dir) gate purely on `state`/`controlledState`/comments-resolved/
  training-released/ownership — no reference to `document.content` anywhere in either file.
- `grep -n '\.content\b'` across `plugins/controlled-documents-resources/src/utils.ts` (which holds
  `sendReviewRequest`/`sendApprovalRequest`/`completeRequest`/`rejectRequest`) and across
  `server-plugins/controlled-documents-resources/src/index.ts` (which holds `OnDocHasBecomeEffective`
  and the rest of the trigger chain) returns **zero matches** — none of the request/approval/
  effective-transition machinery touches rich-text content, so a `content: null` file-based document
  flows through identically to a rich-text one.

Conclusion: the lifecycle *state machine and workflow* required no code changes. What was actually
missing was **data continuity across revisions** and **visibility**, addressed below.

### Changed modules

| Module | Change | Classification |
|---|---|---|
| `plugins/controlled-documents-resources/src/docutils.ts` | `createNewDraftForControlledDoc` already manually carries the `DocumentTemplate` mixin onto each new revision's document id (see the existing block right above the new one). Added an identical block for the QMS `ControlledFile` mixin: if the source revision has a linked Drive file, the new draft revision gets the same `controlledFile` ref via `ops.updateMixin`. Without this, creating a new revision from a file-based document silently lost the file link — the new revision's Controlled File tab would show "no file linked" even though the old revision still had one. ~10 lines, same shape as the existing template block, one new id-only import (`@hcengineering/qms-controlled-file`, already a dependency of this package since Milestone 3). | CORE-ADJACENT PATCH (small, isolated, mirrors an existing pattern in the same function — not a restructure) |
| `plugins/qms-controlled-file-resources/src/components/ControlledFileTab.svelte` | Added a `StatePresenter` (imported from `@hcengineering/controlled-documents-resources`, the exact same badge component the main document list/grid uses) near the top of the tab, so the lifecycle state governing the linked file is unmistakable — serves PG-017 without implementing it as its own milestone. | PLUGIN/EXTENSION |
| `plugins/qms-controlled-file-resources/package.json` | Added `@hcengineering/controlled-documents-resources` dependency for the above import. No cycle: `controlled-documents-resources` depends only on the base `qms-controlled-file` package (id-only), never on `qms-controlled-file-resources`. | CONFIGURATION |

### DocumentSnapshot: no change needed

`createDocumentSnapshotAndEdit` (`docutils.ts`) creates a `ControlledDocumentSnapshot` (a
point-in-time content capture) and resets `controlledState` — but it operates on the **same
document id** (`document._id`), it does not create a new revision. Mixin data is addressed by
object id, so the `ControlledFile` mixin stays attached to the live document automatically; nothing
to carry forward here. Only `createNewDraftForControlledDoc` (which mints a *new* document id) needed
the fix above.

### Rollback

1. `git revert` this milestone's two commits (or reset to the commit before them, if nothing has
   landed on top).
2. No data migration exists to reverse. Any `ControlledFile` mixin data already carried onto a new
   revision by the fix is harmless to leave in place even after reverting the code — it's just an
   inert field value, not something with side effects.

### Manual verification steps

1. `rush build` (no new dependencies beyond the already-existing `qms-controlled-file` /
   `controlled-documents-resources` workspace packages, so `rush install` is not required, but run
   it if in doubt).
2. In the running app: open a Controlled Document that already has a linked Drive file (Milestone 3
   setup), confirm the **File** tab now shows a status badge (Draft/In Review/etc.) at the top.
3. Send it through Review → Approval → Effective (or just Draft → Effective for a document with no
   reviewers/approvers configured) and confirm the badge updates live.
4. Create a new revision (major or minor) from that document. Open the new Draft revision's **File**
   tab and confirm the same Drive file is still linked (this is the regression the fix targets —
   before this milestone, the new revision would show "no file linked").
5. Confirm nothing else changed: sending a rich-text-only (no linked file) Controlled Document
   through the same review/approval flow behaves exactly as it did before this milestone.

### Follow-up decisions flagged, not made unilaterally

- **No locking/enforcement**: confirmed by design, not an oversight — see the scope note above.
  A linked file can still be freely replaced or relinked at any document state, including
  Effective. This is exactly what Milestone 5 (PG-004's other half, plus PG-018) needs to close.
- **New-revision file carry-forward always re-links the same File, never resets it**: this seems
  like the right default (mirrors "same document, new content" the same way Drive's own versioning
  works), but if a future workflow wants a new revision to start with *no* file linked (forcing an
  explicit re-link), that would need a small opt-out — not built speculatively here.
- **Correction, made in Milestone 5**: the "same File" assumption above turned out to be wrong
  once PG-018 locking exists — see Milestone 5's section below for why, and what changed. The new
  revision now gets its own Drive File (an initial-version copy of the old one), not a reference
  to the same File `_id`. Flagging this here so the history of the decision stays visible instead
  of silently rewriting this section.

---

## Milestone 5 — Revision protection + audit trail (PG-018 / PG-008)

**Goal:** "Prevent released content from being silently modified. Implement revision history and
event tracking." Concretely, the brief's own acceptance test: take an Effective XLSX document,
attempt to replace its file, and the system must never allow it to silently succeed while the
revision number stays put.

### Part A — PG-018: blocking the replacement (the real technical work)

**Classification: NEW SERVICE** (a genuine pre-commit server `Middleware`, not a reactive
`Trigger` — triggers in this codebase only run *after* a transaction is already applied and
cannot block anything; confirmed by reading `foundations/server/packages/middleware/src/
spacePermissions.ts`, which is one of only two places in the codebase that actually rejects a
transaction before commit) **+ a 2-line CONFIGURATION change** to wire it into the pipeline.

**Precedent used:** `server-plugins/rating`'s `RatingMiddleware` is a near-exact structural match
for this need (inspect incoming `TxCUD` shapes in `tx()`, throw a plain `Error` to reject before
`this.provideTx(...)` is called, registered as its own standalone package directly in
`server/server-pipeline/src/pipeline.ts`'s middleware list — not through the plugin/trigger-
resource indirection that `server-plugins/drive`'s `OnFileVersionDelete` trigger uses, because
middleware isn't wired that way in this codebase). New package `server-plugins/qms-controlled-
file` (`@hcengineering/server-qms-controlled-file`) follows that exact template.

| Module | Change |
|---|---|
| `server-plugins/qms-controlled-file` (new package) | `QmsControlledFileLockMiddleware`: rejects (a) `TxCreateDoc<FileVersion>` (a new version upload) and (b) `TxUpdateDoc<File>` with `operations.file` set (`restoreFileVersion()` repointing "current version" at an older one) whenever the target Drive `File` is the `controlledFile` of a `ControlledDocument` in `DocumentState.Effective`. |
| `server/server-pipeline/src/pipeline.ts` | +2 lines: import, and one entry in `createServerPipeline`'s `middlewares` array, positioned right after `RatingMiddleware.create` (i.e. after `ApplyTxMiddleware`, which already unwraps `TxApplyIf` batches into flat txes — see the code comment for why the middleware's own `TxApplyIf`-handling branch is defense-in-depth, not the primary path). Not added to `createBackupPipeline`, matching `RatingMiddleware`'s own choice. |
| `server/server-pipeline/package.json`, `rush.json` | dependency + project-list wiring, same shape as every prior milestone's new package. |

**Why both TxCreateDoc and TxUpdateDoc are checked:** a first pass only blocked new-`FileVersion`
uploads (the brief's literal example). But Drive also lets you *restore* an older version
(`restoreFileVersion()`, a plain `TxUpdateDoc<File>` with `operations.file` set to an older
`FileVersion` ref, no new version created) — that's a second, equally silent way to change what
"the current file" means for an Effective document, so it needed the identical guard. Renaming a
file's title, or any other `File`/`FileVersion` metadata edit, is deliberately **not** blocked —
scoped strictly to the two operations that change *content identity*.

**Query mechanics worth calling out:** the middleware queries `documents.class.Document` (the
base class) with a plain field name `controlledFile`, even though that field only exists on the
`ControlledFile` mixin from Milestone 3. This works because the Mongo adapter auto-resolves a bare
field name to its owning mixin's storage path when it isn't found on the base class
(`checkMixinKey` in `foundations/server/packages/mongo/src/storage.ts`) — confirmed by reading
that function, not assumed. No mixin class ref needs to appear in the query.

### A cross-milestone bug found and fixed while implementing Part A

Milestone 4's revision carry-forward pointed a new Draft revision at the **same** Drive File as
the revision it was drafted from. That's fine in isolation, but combined with this milestone's
lock it's actively broken: the *old* revision stays `Effective` until the *new* one itself becomes
Effective (see `OnDocHasBecomeEffective` in Milestone 1's research), so both revisions would
reference the same File at the same time — meaning the moment a Draft author tried to upload their
first real new version, this milestone's own lock would reject it, because the File is still the
`controlledFile` of the (still Effective) old revision. **File-based revisions would have been
unable to ever start editing**, a full workflow break, not a minor edge case.

**Fix** (`plugins/controlled-documents-resources/src/docutils.ts`, inside
`createNewDraftForControlledDoc`): the new revision now gets its **own** new Drive `File` (via
`@hcengineering/drive`'s `createFile`), created in the same Drive/folder as the old one, with its
initial `FileVersion` pointing at the **same underlying `Blob`** as the old File's current version
— a metadata-only copy (no byte duplication; `Blob`s are immutable content, so two independent
`FileVersion` records safely reading the same one is fine). This mirrors how Huly's own
native rich-text documents already work: `docSpec.content` in the same function starts as a *copy*
of the old revision's markup, never a shared reference. The old File, and the still-Effective
revision that points at it, are completely untouched.

**Classification:** CORE-ADJACENT PATCH to `plugins/controlled-documents-resources` (same file
Milestone 4 already touched) + new dependency on `@hcengineering/drive` for that package. Kept to
one isolated, heavily-commented block, same bar as every other core-adjacent change in this
branch.

**Known residual risk, flagged not fixed:** if someone explicitly deletes the *old* File's current
`FileVersion` from Drive's own version history UI, `OnFileVersionDelete`
(`server-plugins/drive-resources`) removes the underlying `Blob` — which the *new* File's initial
version also references, breaking its preview/download too. This only happens on a deliberate,
manual version-history deletion (never during normal use), and Drive itself has no existing
protection against deleting a version that's in active use elsewhere, so this isn't a regression
this milestone introduces so much as an existing Drive gap this milestone's design now depends on
not being hit. Worth hardening later (e.g. a reference count, or blocking `FileVersion` deletion
for blobs referenced by more than one File) but out of scope for this MVP.

### Part B — PG-008: audit trail

**Classification: verified already-working, nothing built.** Confirmed by reading
`server-plugins/activity-resources/src/utils.ts` and `index.ts`: `TxMixin` transactions are
explicitly handled alongside `TxUpdateDoc` when generating activity messages (`core.class.TxMixin`
appears in the same switch/dispatch as `TxUpdateDoc`, and `updateMixin4Doc`-style diffing is
applied to mixin field changes same as regular field changes). Since linking/changing a Controlled
Document's file is a `TxMixin` on `qmsControlledFile.mixin.ControlledFile` (Milestone 3's
`createMixin`/`updateMixin` calls), it already generates an activity entry, visible in the
existing `DocumentHistory` tab (`documentRes.string.HistoryTab` in `EditDocPanel.svelte`) — no new
code needed. Combined with Huly's core being transaction-log based (every `Tx` persisted,
nothing editable/deletable after the fact), this satisfies "implement revision history and event
tracking" for actual changes.

**Explicitly out of scope:** logging *rejected* attempts (someone tried to replace an Effective
file and was blocked) is not implemented. The brief asks to prevent silent modification and to
track real events — it doesn't ask for a log of blocked attempts, and Part A's middleware already
surfaces a clear error to the user in the moment, so there's no silent failure to compensate for.
If audit-grade "attempted tampering" logging becomes a real requirement (e.g. for IATF evidence of
control effectiveness), that's a deliberate follow-up, not an oversight.

### Rollback

This milestone's blast radius is a live production risk if the lock over- or under-blocks, so:

1. **Fastest rollback (no revert needed):** remove the one line
   `QmsControlledFileLockMiddleware.create,` from the `middlewares` array in
   `server/server-pipeline/src/pipeline.ts` and redeploy the transactor — the lock is inert the
   moment it's out of the pipeline, no data was ever written by it (it only throws, never
   mutates), so nothing needs cleaning up.
2. **Full rollback:** `git revert` this milestone's commits. The `server-plugins/qms-controlled-
   file` package can be deleted entirely with zero data-model impact (it holds no schema, no
   `createModel`, nothing in `models/`).
3. **The docutils.ts fix is independent** of Part A and safe to keep even if Part A is rolled
   back — it only changes what a new revision's `controlledFile` points at, it doesn't enforce
   anything itself. Revert it separately only if the "new File per revision" behavior itself is
   unwanted.
4. No data migration exists in either direction — nothing written by this milestone is referenced
   by anything else if removed.

### Manual verification steps

1. `rush install` (new package) → `rush build` → `rush bundle` → `rush docker:build` (the
   middleware runs in the transactor/server process, not a separate pod, so a full rebuild is
   needed, not just a frontend bundle) → `docker compose -f dev/docker-compose.yaml up -d
   --force-recreate`.
2. **Negative path:** open a Controlled Document with a linked Drive file, send it through
   Review → Approval → Effective. On the **File** tab, attempt to upload a new version (or use
   Drive directly to upload a new version to that same File). Expect a clear rejection error
   naming the controlling Effective document, not a silent failure or a generic 500.
3. Still on that Effective document's linked File in Drive: attempt "restore an older version".
   Expect the same rejection.
4. **Positive path:** create a new revision from that Effective document (Draft). Confirm the
   File tab shows a file linked (Milestone 4 behavior) and that it is a **different** File than
   the original (check via Drive, or compare the file's identity in dev tools) — then upload a
   new version to it. Expect success, and confirm the *original* Effective revision's File tab is
   completely unaffected (same file, same preview, same version count as before).
5. Confirm a rich-text-only Controlled Document (no linked file) is entirely unaffected by any of
   this — the middleware never matches a `Document` without the `ControlledFile` mixin's
   `controlledFile` field set.
6. Confirm renaming a linked file's title on an Effective document still works (deliberately not
   blocked).

### Follow-up decisions flagged, not made unilaterally

- **Residual blob-sharing risk** on manual version-history deletion — see above; not fixed in
  this milestone.
- **Logging rejected attempts** — deliberately out of scope; see Part B above.
- **The old File's own version history keeps growing forever** after a document line is
  superseded (each revision's File is independent now, so this is actually *less* of a growth
  concern than before — each File's version count only reflects that one revision's own edit
  history, not the whole document lineage). No cleanup/archival built; not asked for.

---

## Milestone 6 — Document Registry (PG-016)

**Classification: mostly CONFIGURATION (nothing built already existed), one CORE-ADJACENT
column addition.**

### The main finding: the Document Registry already exists

Before writing any code, investigated how controlled-documents lets you browse documents today
(`plugins/controlled-documents-resources/src/index.ts`, `models/controlled-documents/src/index.ts`).
Result: the brief's ask — "a centralized Document Registry view, filterable by status/process/
department/document type/owner, preferring existing Huly views over an isolated application" —
**is already almost entirely built and already shipping**, under the name **"Library"**:

- `models/controlled-documents/src/index.ts` (~line 204-224) registers a `special` nav entry
  `id: 'library'` in the Documents app, rendering `documents.component.DocumentsContainer` with
  query `{ [documents.mixin.DocumentTemplate]: { $exists: false } }` — **no `space`/Project
  filter**, i.e. it already spans every Project. Mode tabs: Effective / In Progress / Archived /
  Obsolete / All.
- `DocumentsContainer.svelte` → `Documents.svelte` → `ViewletPanelHeader` resolves the Viewlet
  registered at `documents.viewlet.TableDocument` (same file, ~line 298-355): a `Table`-descriptor
  Viewlet attached to `documents.class.Document` with columns **ID, Title, Status, Version,
  Project(`space`), Category, Template, Template Version, Owner, Labels, Modified On** — i.e.
  Document ID / Title / Type(-via-Category) / Revision / Status / Owner from the brief's column
  list, already present, already sortable.
- `builder.mixin(documents.class.Document, core.class.Class, view.mixin.ClassFilters, {...})`
  (same file, ~line 712-738) already registers **filtering by `state` (Status), `owner`,
  `category` (Type), `space` (Project), plus title/prefix/labels/major/minor/author/modifiedOn**
  — i.e. the brief's "filter by status / document type / owner" is already live, using the
  platform's standard generic filter bar. No new filter UI was needed or built.

Given this, re-implementing a "Document Registry" as a new app/view would have been pure
duplication — directly against the brief's own "prefer extending existing Huly views" rule and
the top-level "do not create unnecessary deep modifications" principle. **This milestone's actual
work was to identify this, add the one genuinely missing column, and honestly flag the two
columns nothing backs.**

### What changed

| Module | Change | Classification |
|---|---|---|
| `models/controlled-documents/src/index.ts` | Added one entry, `{ key: 'effectiveDate', label: documents.string.EffectiveDate }`, to the existing `documents.viewlet.TableDocument` config array (~line 348). | CORE-ADJACENT (see below) |

Nothing else was touched. No new packages, no new model classes, no server changes, no docker/env
changes.

### Why this one column addition is safe (verified, not assumed)

`effectiveDate` is declared on `ControlledDocument` (`plugins/controlled-documents/src/types.ts:215`),
not on the base `documents.class.Document` this Viewlet's `attachTo` targets. Verified this is
still safe to add as a bare `{ key, label }` entry:
- `Viewlet.config: (BuildModelKey | string)[]` (`plugins/view/src/types.ts:460`) is not typed
  against `keyof` the attach class — it's a generic string/object array. No TypeScript error is
  possible from referencing a subclass-only field name.
- The existing config array already ends in a bare `'modifiedOn'` string entry with no explicit
  presenter, proving the "plain field key, default presenter" pattern is already used and working
  in this exact Viewlet — `effectiveDate` (a `Timestamp`) follows the identical pattern.
- `configOptions.strict: true` on this Viewlet is a *runtime* rendering-mode flag
  (`ViewletConfigOptions` in `plugins/view/src/types.ts:472`, no attachment to model-build
  validation) — not a build-time or model-validation constraint that could reject this field.
- At runtime, rows that are plain (non-controlled) `Document`s simply have `effectiveDate ===
  undefined` and render a blank cell — no crash, no special-casing needed.

This is a one-line, low-risk, precedent-following addition — kept as a "core-adjacent" change
(not "CONFIGURATION") only because it touches a file inside `models/controlled-documents`, per
this project's own classification convention; it does not rewrite or restructure anything.

### Deferred, not built: "Department" and "Process" columns

The brief's example columns include Type / **Department** / **Process**. Investigated whether
anything backs Department or Process today:
- `DocumentCategory` (the `category` ref, already shown as the Registry's "Type"-ish column) has
  fields `code`, `title`, `description` only (`plugins/controlled-documents/src/types.ts`) — no
  department/process concept.
- `DocumentSpace`/`Project` (the `space` a document lives in) is an organizational grouping, not
  a department or process field, and is already shown as its own "Project" column — conflating it
  with "Department" or "Process" would be a wrong, confusing reuse, not a real mapping.
- No other field on `Document`/`ControlledDocument` backs either concept.

**Not implemented.** Inventing a new required field/mixin to fill two columns with no real backing
data yet would be exactly the kind of speculative modeling the brief itself warns against
elsewhere (PG-010: "First create a reusable architecture... do not implement every object now").
Flagged below as a follow-up decision for the pilot, not decided unilaterally.

### Rollback

`git revert` the single commit (`9b5848143` — see `git log` on `custom/qms-tpp`). The column
addition is fully self-contained in one array entry; reverting it leaves the pre-existing
"Library" view and its filters completely untouched and working exactly as before this milestone.

### Manual verification steps

1. `rush build` (compiles the changed model package this file lives in; no new dependencies, no
   new packages — fast to verify relative to prior milestones).
2. Open the Documents app → **Library** in the left navigator. Confirm it lists documents across
   every Project (not scoped to one), with mode tabs Effective/In Progress/Archived/Obsolete/All.
3. Confirm the table shows an **Effective Date** column, populated for Effective/Obsolete
   documents and blank for Draft ones (no `effectiveDate` set yet).
4. Open the filter bar and confirm Status, Owner, Category, and Project are all filterable —
   this was already working before this milestone; verify it's still intact after the change.
5. Confirm "My Documents" (the other consumer of the same underlying components, scoped to
   `owner: currentEmployee`) is unaffected and still renders correctly with the new column.

### Follow-up decisions flagged, not made unilaterally

- **Department / Process columns**: no backing data model exists yet. Options for a future
  milestone: (a) a new mixin on `Document` with `department`/`process` reference or free-text
  fields, mirroring the `ControlledFile` mixin's external-package pattern from Milestone 3; (b)
  repurpose `DocumentCategory` more broadly if the pilot's category taxonomy naturally maps to
  departments; (c) determine these are out of scope for the TPP pilot's actual reporting needs
  and drop them from the target column list entirely. Needs a decision from whoever owns the
  QMS taxonomy, not a unilateral schema choice.
- **"Library" naming**: the existing nav label is "Library," not "Document Registry" or
  "Registry." Whether to rename it (a `documents.string.Library` label lives in the base
  `controlled-documents` plugin's strings — renaming it would be a small edit to that upstream
  package, not this milestone's additive packages) is a cosmetic decision left to the user/pilot,
  not made here.

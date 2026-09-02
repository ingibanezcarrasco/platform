# QMS Architecture Analysis — Milestone 1

**Branch:** `custom/qms-tpp` · **Status:** Investigation complete, no code changes yet · **Scope:** PG-001 through PG-005 groundwork

This document maps the existing Huly architecture relevant to ISO 9001 / IATF 16949 document control, before any implementation. Per the project's core principle, every later change must be classified as **CONFIGURATION**, **PLUGIN/EXTENSION**, **NEW SERVICE**, or **CORE PATCH** — this analysis exists to make that classification possible and to keep changes rebaseable onto upstream `develop`.

---

## 1. Huly Drive file model

Types: `plugins/drive/src/types.ts`. Model/DB schema: `models/drive/src/index.ts`. Domain: `DOMAIN_DRIVE = 'drive'` (single Mongo domain for everything below).

Class hierarchy: `Drive` (a `TypedSpace`) → `Resource` (abstract, domain `drive`) → `Folder` | `File`.

- **`Resource`** (`types.ts:29-38`): `title`, `parent: Ref<Resource>`, `path: Ref<Resource>[]` (materialized ancestor chain), `comments?`.
- **`Folder`**: narrows `parent`/`path` to `Ref<Folder>`.
- **`File`** (`types.ts:49-56`): `file: Ref<FileVersion>` (pointer to *current* version), `versions: CollectionSize<FileVersion>`, `version: number` (monotonic ordinal).
- **`Drive`**: bare `TypedSpace` with a `DefaultDriveTypeData` mixin implementing `RolesAssignment`.

No file-type-specific storage — plain platform Doc/AttachedDoc persistence throughout.

## 2. Blob/storage implementation

`Blob` (metadata only, not content) is defined in `foundations/core/packages/core/src/classes.ts:707-718`: `provider`, `contentType`, `etag`, `version`, `size`. Actual bytes live behind a pluggable `StorageAdapter` (`foundations/core/packages/storage/src/index.ts:43-75`: `stat/get/put/read/partial/remove/getUrl`, workspace-scoped).

Concrete adapters: `foundations/server/packages/{s3,minio,datalake,hulylake,server-storage}`. This dev environment's `STORAGE_CONFIG="datalake|http://huly.local:4030"` selects `DatalakeService`, proxying to the `pod-datalake` HTTP service.

**Fetch/upload path** is entirely generic, not Drive-specific: front server's `/files/*` route (`server/front/src/index.ts:462-567` for GET, `589-640` for POST) resolves workspace from token, calls `storageAdapter.stat()`/`get()`/`partial()` (Range-supported), and does on-the-fly image resize via `getGeneratePreview` (`index.ts:731-880`). **Drive rides entirely on this shared plumbing — no Drive-specific storage code exists.**

## 3. Version handling

`FileVersion` is a first-class `AttachedDoc<File, 'versions', Drive>` (`types.ts:59-67`): `title`, `file: Ref<Blob>`, `size`, `type` (MIME), `lastModified`, `metadata?` (thumbnail/blurhash), `version: number`.

- **New upload = new version, never an overwrite.** `createFileVersion` (`plugins/drive/src/utils.ts:77-104`) increments `File.version`, adds a new `FileVersion` doc, repoints `File.file` — all in one transaction. Old versions/blobs are retained.
- **"Current version"** is the `File.file` pointer, not "highest number" — this is what makes rollback trivial.
- **Restore** (`restoreFileVersion`, `utils.ts:107-120`) is a pointer swap only — no data movement, no deletion.
- Deleting a `FileVersion` triggers `OnFileVersionDelete` (`server-plugins/drive-resources/src/index.ts:31-51`), which removes the underlying blob.

This model is a very close match for QMS "revision" semantics already (immutable history + single current pointer).

## 4. Preview service

Two independent layers exist today:

1. **Generic image resize** (`server/front`, `getGeneratePreview`, `index.ts:731-880`): resizes images via `sharp`, caches the derived blob **back into the same `StorageAdapter`** under key `"${uuid}%preview%${size}${format}"`. This is the reference pattern for a revision-aware cache: derive the key from the source blob id, store as an ordinary blob.
2. **`pods/preview` microservice** — **already implements LibreOffice-headless conversion.** `pods/preview/src/utils/libreoffice.ts` spawns `libreoffice --headless --convert-to pdf`; `providers/doc.ts` recognizes `.docx/.doc/.pptx/.ppt/.xlsx/.xls/.odt/.ods/.odp/.rtf`, converts doc→PDF→PNG, and a matching `providers/pdf.ts` does PDF→PNG. **Limitation: its HTTP surface (`GET /metadata/:workspace/:name`, `GET /image/:transform/:workspace/:name`) only returns a single-page PNG thumbnail — the intermediate PDF is discarded** (`this.tempDir.rm(pdfFile)`). Caching is an in-process disk LRU **local to the pod**, not shared across replicas, not persisted to blob storage. It is not configured in `dev/.env` today (optional, separately deployed).

**Conclusion:** the conversion primitive (`docToPdf`) is directly reusable; we need a new endpoint (or thin sibling service) that returns/persists the *full* converted PDF as a blob in the workspace's own `StorageAdapter`, not the pod's local disk.

## 5. Frontend preview selection logic

Not hardcoded per file type — a registered-extension pattern. `packages/presentation/src/components/FilePreview.svelte` calls `getPreviewType(contentType, $previewTypes)` (`packages/presentation/src/filetypes.ts:86-98`), which matches live `FilePreviewExtension` docs' `contentType` glob arrays (e.g. `['application/pdf']`, `['video/*']`) against the file's MIME and dynamically renders `previewType.component`.

Registrations are pure model docs: `models/view/src/index.ts:760-793` registers `view.component.PDFViewer` for `application/pdf`, etc. The PDF viewer (`packages/presentation/src/components/PDFViewer.svelte`) wraps `EmbeddedPDF` — a plain `<iframe src={blobUrl}#view=FitH>` using the browser's native renderer.

Drive hooks in generically: `plugins/drive-resources/src/components/EditFile.svelte:44-51` renders `<FilePreview file={blob} contentType={version.type} .../>`.

**This is the cleanest extension point for PG-001/PG-002**: register a new `FilePreviewExtension` for Office MIME types → a new component that resolves/streams a converted-PDF blob and hands off to the existing `PDFViewer`. Zero changes to `models/drive`, `plugins/drive`, or `packages/presentation`.

## 6. MIME-type logic

**Client-supplied and trusted, not sniffed server-side.** Browser-native `file.type` is captured in `plugins/drive-resources/src/utils.ts:298-316` and written verbatim to `FileVersion.type`. The server's `handleUpload` returns `mimetype` metadata but doesn't enforce it against what gets persisted. `getFileTypeIcon` (`utils.ts:136-147`) maps content-type prefixes to icons; the preview resolver (§5) matches on the same trusted value.

**Risk:** a mislabeled upload silently fails to preview instead of converting. If "must render preview" becomes a hard QMS requirement, server-side signature-based sniffing should be added before trusting `FileVersion.type`.

## 7. TraceX Controlled Document model

Types: `plugins/controlled-documents/src/types.ts`. Model: `models/controlled-documents/src/index.ts`.

Hierarchy: `DocumentMeta` (stable identity across all revisions) → `ProjectMeta`/`ProjectDocument` (folder placement per QMS "Project"/space) → `Document` (base: `title`, `code`, `prefix`, `seqNumber`, `major`/`minor`, `category`, `author`, `owner`, `state`, `content: MarkupBlobRef | null`, `attachments?`, `comments?`, `snapshots?`) → `HierarchyDocument` (attached to `DocumentMeta`) → `ControlledDocument` (adds `requests`, `reviewers`, `approvers`, `externalApprovers`, `coAuthors`, `reviewInterval`, `controlledState`, `plannedEffectiveDate`, `effectiveDate`, `changeControl: Ref<ChangeControl>`).

`DocumentTemplate` mixin covers reusable templates; `DocumentCategory` covers QMS domains/categories.

**Critical finding:** `Document.content` is Huly-native collaborative rich text (Tiptap/Yjs `MarkupBlobRef`) — **not a reference to an uploaded file or a Drive `File`**. "Reference a Drive file as controlled content" (PG-003) is genuinely new integration surface; it cannot be retrofitted onto the existing content field.

## 8. Revision model

New revisions are **new documents, not overwrites**: `createNewDraftForControlledDoc` (`plugins/controlled-documents-resources/src/docutils.ts:76`) creates a fresh `ControlledDocument` attached to the *same* `DocumentMeta`/`code`/`seqNumber`, with new `major`/`minor`, `state: Draft`, and a fresh `ChangeControl`. No `previousRevision`/`nextRevision` field exists — order is derived at query time via `compareDocumentVersions`/`getDocumentSortSequence` (`plugins/controlled-documents/src/utils.ts:157-168`).

`DocumentSnapshot`/`ControlledDocumentSnapshot` additionally capture point-in-time content+state *within* a single revision's life (e.g. before a major review-cycle edit).

**Verdict: reuse directly, no modification needed.** This already satisfies PG-005's revision-history requirements for Huly-native documents; the open question is only how a `ControlledFile` (file-based revision) mirrors the same chaining.

## 9. Review workflow

`DocumentState`: `Draft, Effective, Archived, Deleted, Obsolete`. `ControlledDocumentState` (sub-state during the Draft→Effective transition): `InReview, Reviewed, InApproval, Approved, Rejected, ToReview`.

Transition *initiation* and client-side guarding live in effector stores (`plugins/controlled-documents-resources/src/stores/editors/document/`): `canSendForReview.ts` (Draft + owner + latest version only), `canSendForApproval.ts` (requires **all comments resolved**, and if training is attached, `Training.state === Released`).

**Caveat:** these guards are UI-layer (effector stores), not enforced by a hard server-side FSM validator that rejects illegal state writes. Permission-level enforcement (who may write at all) *is* real and server-checked via the space-type role/permission system. For an auditable QMS, a server-side transition validator should be added (new, small, following the existing trigger pattern) rather than trusting the client guard alone.

## 10. Approval workflow

Reviewer/approver assignment is **not role-based** — it's explicit employee arrays on `ControlledDocument` (`reviewers`, `approvers`, `externalApprovers`, `coAuthors`), set via `sendReviewRequest`/`sendApprovalRequest` (`plugins/controlled-documents-resources/src/utils.ts:221,248`). `externalApprovers` get special `Collaborator` grants for approvers outside the space.

The role/permission *system* itself (`QualifiedUser`, `Manager`, `QARA` in `models/controlled-documents/src/roles.ts`, permissions in `permissions.ts`) governs *who can act* (review/approve/archive/create), while assignment governs *who is asked* — two orthogonal layers, both reusable as-is.

Underlying mechanism: a generic `Request`/`DocumentRequest` (`plugins/request/src/index.ts:26`) with `requested/approved/approvedDates/rejected/status/tx/rejectedTx`. Server trigger `OnRequestUpdate` (`server-plugins/request-resources/src/index.ts:65-113`) auto-stamps dates and applies the stored `tx`/`rejectedTx` on completion — this is a generic, reusable request/approval primitive already used well beyond documents.

## 11. Signature/audit behavior

Real re-authentication e-signature: `SignatureDialog.svelte` prompts email+password, calls `accountClient.login()` to re-validate identity before dispatching `completeRequest`/`rejectRequest`. Evidence (person, role, state, timestamp) is reconstructed in `plugins/controlled-documents-resources/src/utils.ts` (~line 1140-1200) into `DocumentApprovalState[]`.

Audit trail substrate: Huly's core is transaction-log based — every `Tx` is persisted, `Request` completion is driven by stored `tx`/`rejectedTx`, and `activity`/`DocUpdateMessage` notifications fire on nearly every field change. No UI path exists to edit or delete a completed approval.

**Compliance gap for 21 CFR Part 11 / IATF audit-grade signing:** today's signature reauthenticates identity but does not bind the signature cryptographically to the exact content version signed (no hash/manifest of what was approved). Worth a small extension (mixin on the approval record) if that level of rigor is required — not a core patch.

## 12. Training integration

Already fully wired, bidirectionally — this is the strongest "don't rebuild it" finding in the whole analysis:

- `DocumentTraining` mixin on `Document` (`plugins/controlled-documents/src/types.ts:280-287`): `enabled`, `training: Ref<Training>`, `roles`, `trainees`, `maxAttempts`, `dueDays`.
- `OnDocHasBecomeEffective` server trigger (`server-plugins/controlled-documents-resources/src/index.ts:267`) → `createDocumentTrainingRequest` (line 93): on Effective, resolves trainees (direct + via roles), computes `dueDate`, creates a `TrainingRequest`.
- Reverse gate: `canSendForApproval.ts` blocks approval unless the linked `Training.state === Released`.

The code even has a `// TODO: avoid duplicate logic, reuse createTrainingRequest() from training-resources` comment — a known, minor internal wart, not something we introduce.

**Verdict: reuse directly.** At most, extend `dueDays`/notification templates; do not rebuild the trigger mechanism.

## 13. Reusable extension/plugin points

The proven precedent for extending Drive's core classes **without touching `models/drive`**: `models/server-drive/src/index.ts:25-52` mixes `SearchPresenter` and `ObjectDDParticipant` onto `drive.class.File`/`Folder` purely via `builder.mixin(...)` calls from an entirely separate model package.

This directly supports adding a **`ControlledFile` mixin** (fields: `docNumber`, `state`, `effectiveDate`, `approvedBy`, back-reference to a `ControlledDocument`) onto `drive.class.File`, from a new/extended model package — no edits to `models/drive`, `plugins/drive`, or `server-plugins/drive`.

Similarly, `FilePreviewExtension` (§5) and server-side `Trigger` registration (§12, and `OnFileVersionDelete` in `server-plugins/drive-resources`) are both generic registration mechanisms open to any new package.

## 14. Safest implementation path for PG-001 through PG-005

| PG | Target | Classification | Why |
|----|--------|-----------------|-----|
| PG-001 (Office preview) | New `FilePreviewExtension` + component; extend `pod-preview` (or a new thin service) to return/persist full converted PDF as a blob | **PLUGIN/EXTENSION** + **NEW SERVICE** (extends existing pod, not core) | §4, §5 — conversion primitive exists, only the HTTP surface and cache persistence are new |
| PG-002 (Unified viewer) | Additional `FilePreviewExtension` registrations per format (TXT, CSV native; DOC/XLS/PPT family via PG-001's converter) | **PLUGIN/EXTENSION** | Same registration mechanism as existing PDF/video/text viewers, §5 |
| PG-003 (Controlled-file concept) | New `ControlledFile` mixin on `drive.class.File` (or a new lightweight class linking `ControlledDocument` ↔ `drive.class.File`), in a new model package | **PLUGIN/EXTENSION** | §7, §13 — `Document.content` cannot be reused for this; mixin precedent is proven |
| PG-004 (Lifecycle for file-based docs) | Mirror `DocumentState`/`ControlledDocumentState` vocabulary onto the `ControlledFile` mixin; add a server-side trigger to enforce transitions and block new `FileVersion` creation once Effective | **PLUGIN/EXTENSION**, with one small **CORE-ADJACENT** server trigger (new package, not a patch to `models/drive`) | §8-9, §13 — Drive has no per-document lock today; needed for PG-018 too |
| PG-005 (Revision model) | Reuse `FileVersion` chaining as-is for the underlying file; reuse `ControlledDocument`'s `DocumentMeta`/`major`/`minor` chaining for the metadata/workflow side; join them via the PG-003 mixin | **CONFIGURATION** (no new code — composition of two existing models) | §3, §8 |

**No CORE PATCH is required for any of PG-001 through PG-005.** The one item requiring new server-side enforcement logic (blocking edits to an Effective file) is additive — a new trigger package — not a modification of `models/drive` or `plugins/drive` source.

---

## Proposed files/modules to touch (Milestones 2-4 preview, not started)

New packages (do not exist yet):
- `plugins/qms-preview` / `plugins/qms-preview-resources` — `FilePreviewExtension` registration + Office-preview Svelte component (PG-001, PG-002)
- `server-plugins/qms-preview` / `server-plugins/qms-preview-resources` — conversion-cache orchestration, blob persistence, revision-aware cache key (PG-001, PG-019)
- `pods/office-preview` (or extend `pods/preview`) — new endpoint returning the full converted PDF, not just a thumbnail (PG-001)
- `models/qms-controlled-file` — `ControlledFile` mixin on `drive.class.File`, lifecycle state field, link to `ControlledDocument` (PG-003, PG-004, PG-005)
- `server-plugins/qms-controlled-file` — trigger(s) enforcing lifecycle transitions and blocking edits post-Effective (PG-004, PG-018)

Existing files that only need **registration additions**, not logic changes:
- `models/view/src/index.ts` pattern (reference only — new `FilePreviewExtension` docs go in the new `models/qms-preview` package, not this file)
- `dev/docker-compose*.yaml` — add the new preview/conversion service, following the existing `pods/preview` service definition as a template

Nothing under `models/drive`, `plugins/drive`, `plugins/controlled-documents`, or their `-resources`/server counterparts needs to change for PG-001 through PG-005.

---

## Open questions before Milestone 2

1. Should the Office→PDF conversion cache live behind the existing `pod-preview` (extending its HTTP surface) or as a fully separate `pod-office-preview`? Reuse favors the former; isolation/blast-radius favors the latter. *(Recommendation: extend `pod-preview` — it already has the LibreOffice dependency and temp-file handling; a second service would duplicate that.)*
2. Do we need server-side MIME sniffing before Milestone 2, or is client-asserted MIME acceptable for the pilot? *(Recommendation: defer — acceptable for pilot, revisit before any production QMS use given §6's risk note.)*

---
*Generated as part of Milestone 1 (architecture investigation only). No source files outside `docs/` were modified.*

# QMS Editor Extension Architecture — Milestone 7 Research

**Status:** research only, no code changes. Scope: PG-011 ("Interactive controlled documents").
Goal: determine how Huly's document editor can be extended with new interactive embedded
components (responsibility matrices, process flows, document references, linked tasks,
equipment references, forms, approval blocks, revision-info blocks, training-requirement
blocks), *before* building any of them.

---

## Central question: can a new package register a new interactive block into the editor without a core patch?

**No — not for a genuinely new inline node/mark type.** Huly's own team already hit this
question and answered it by patching the base editor package directly, not by adding an
external registration point. That precedent is the strongest evidence available:

- `Document.content` is edited by `CollaboratorEditor` (`@hcengineering/text-editor-resources`),
  invoked from `plugins/controlled-documents-resources/src/components/document/EditDocContent.svelte:231-268`
  with a `kitOptions` prop (`qms: { qmsInlineComment: {...} }`, `shortcuts`, `toc`, `inlineNote`).
- `kitOptions` only *configures* sub-kits that are already compiled into the editor's schema —
  it cannot add a brand-new one. The schema itself is `StaticEditorKit`, assembled in
  `plugins/text-editor-resources/src/kits/editor-kit.ts` from a **hardcoded, statically-imported
  list** of Tiptap Node/Mark extensions (lines ~15-75: `CodeExtension`, `EmbedNode`, `ImageExtension`,
  `NoteExtension`, `QMSInlineCommentExtension`, `ReferenceExtension`, `TodoItemExtension`, etc.)
- The `qms` sub-kit itself is the proof: `QMSInlineCommentExtension`/`QMSInlineCommentMark`
  (`editor-kit.ts:222-227`) are defined *inside* `text-editor-resources/src/components/extension/qms/`
  — not inside `controlled-documents-resources`, where a truly external plugin would live. The
  kit's own source comment reads `qms: e(subKits.qms, false) // Semi-deprecated, should be removed
  in the future` (`editor-kit.ts:143`). **Huly's own QMS-specific editor extension was built as a
  CORE PATCH to the base editor package** — there was no external extension point to use instead,
  and apparently the team isn't fully happy with having done it that way.

So: adding a genuinely new inline, interactively-editable block type (a live responsibility-matrix
grid, a process-flow canvas, an inline approval-signing widget) requires editing
`plugins/text-editor-resources` directly, the same category of change as `qmsInlineComment`. This
is a real CORE PATCH, not a PLUGIN/EXTENSION, under this project's own classification.

## The one partially-open extension point: `EmbedNode` providers

`EmbedNode` (`plugins/text-editor-resources/src/components/extension/embed/embed.ts:35-46`) takes
an `options.providers: EmbedNodeProvider[]` — and already has two providers wired in,
`YoutubeEmbedProvider` and `DriveEmbedProvider` (`editor-kit.ts:117`). An `EmbedNodeProvider` is a
small interface — `{ buildView: (src) => Promise<EmbedNodeView | undefined>, autoEmbedUrl?: (src) => boolean }`
— dramatically cheaper to write than a whole new Node/Mark (no schema/attribute/parseHTML/NodeView
plumbing to define from scratch).

**But the `providers` array itself is still a hardcoded literal inside `editor-kit.ts`**
(`providers: [YoutubeEmbedProvider(defaultYoutubeEmbedUrlOptions), DriveEmbedProvider(defaultDriveEmbedOptions)]`),
not populated from a model-doc registry the way `FilePreviewExtension` (Milestone 2) or `Viewlet`
(Milestone 6) are. So a new embed provider (e.g. "preview a linked Controlled Document inline")
still needs a patch to `editor-kit.ts` — but a *small* one: one new provider file + one array
entry, structurally identical in size/risk to Milestone 5's `pipeline.ts` patch.

## The already-free mechanism: `@mention` references

`ReferenceExtension` (`plugins/text-editor-resources/src/components/extension/reference.ts:39-53`)
is a fully generic `@`-triggered mention/reference node — it can already reference **any** Huly
`Doc` class today (`docClass?: Ref<Class<Doc>>` option, resolved via the standard object-search/
suggestion machinery, same family as `ObjectSearchBox` used in Milestone 3's Controlled File tab).
Typing `@` and picking a Controlled Document, a Tracker issue, a contact, etc. inside a document's
rich text already works with **zero new code**.

Combined with the fact that **tables** (`TableHeader` from `@tiptap/extension-table-header`,
standard in the base kit) and **TodoItem/TodoList checkboxes**
(`foundations/core/packages/text/src/kits/common-kit.ts:132-133`,
`plugins/text-editor-resources/src/components/extension/todo/todo.ts`) are already standard,
always-on editor features, several of PG-011's example components need **no new code at all**.

## Architectural recommendation: compose by reference, not by schema extension

The cheapest, lowest-risk path for most of PG-011's remaining wishlist is to **not** fight the
closed editor schema at all: model an interactive component (a responsibility matrix, a form
template, an approval block) as its **own first-class Huly object class** with its own dedicated
edit UI — the exact pattern already proven in Milestone 3 (`ControlledFile` mixin + a normal
Svelte panel/tab, not an inline editor node) — and link it into the document body via the
already-free `@mention` reference (zero patch) or, if an inline visual preview is wanted, a new
`EmbedNodeProvider` (small patch). This sidesteps `text-editor-resources` entirely for the data
model and UI, and only touches it (minimally) for the optional inline-preview affordance.

This mirrors PG-012's own "Document / Form Template / Record" separation — the interactive
components the brief describes are naturally separate QMS objects, not paragraphs of rich text.

---

## Proposal table — PG-011 example components

| Component | Closest existing precedent | Feasibility | Classification |
|---|---|---|---|
| Responsibility matrix | Tables (`@tiptap/extension-table-header`, already in every document) | **Easy** — usable today as a table + column convention, zero code | None needed (CONFIGURATION at most, e.g. a table template) |
| Process flow diagram | None close — no diagramming node exists in the editor | **Hard** as an inline editable node (CORE PATCH, novel Node type + canvas UI) · **Moderate** as an externally-authored diagram referenced/embedded (e.g. an SVG/image uploaded to Drive, previewed via Milestone 2/3's existing file-preview infra) | CORE PATCH (inline) or PLUGIN/EXTENSION (referenced) — recommend the latter |
| Document references | `ReferenceExtension` (`@mention`, already generic over any `Doc` class) | **Easy** — works today, zero code | None needed |
| Linked tasks | `@mention` (reference a Tracker issue) + `TodoItem`/`TodoList` (checkbox lists, already standard) | **Easy** — works today, zero code | None needed |
| Equipment references | `@mention`, generic over any `Doc` class | **Easy** once an Equipment class exists (it doesn't yet — out of scope per PG-010's own "don't model every object now") | PLUGIN/EXTENSION (new model class only, no editor changes) |
| Forms | No inline precedent; structural precedent = `training`'s own template/quiz split (`Training` + `Question`, per Milestone 1 research) and Milestone 3's `ControlledFile`-as-referenced-object pattern | **Moderate** — new object classes (FormTemplate/FormRecord per PG-012) + dedicated UI, referenced from the document via `@mention`, no editor schema changes needed | PLUGIN/EXTENSION |
| Approval blocks | Already fully solved *outside* the rich-text body — `Request`/`DocumentRequest` + `SignatureDialog` + the `DocumentApprovalState[]` evidence view (Milestone 1 research), surfaced in the document panel, not embedded in `content` | **N/A** — no editor work needed | Already exists |
| Revision info | Already solved outside content — `StatePresenter` (reused in Milestone 4), document metadata fields | **N/A** | Already exists |
| Training requirements | Already solved outside content — `DocumentTraining` mixin + training-request UI (Milestone 1 research) | **N/A** | Already exists |

## Recommendation for a future prototype

**Do not prototype a new inline Node/Mark type next.** Three of the nine example components are
already fully solved (approval/revision-info/training, all surfaced in the document panel rather
than the body), three more need zero editor code (`@mention` + tables + todo lists cover
responsibility matrix, document references, and linked tasks), and one (equipment references)
just needs a new model class with no editor work.

If the team wants one concrete thing to prototype in a future milestone, the lowest-risk candidate
is a **`ControlledDocument` `EmbedNodeProvider`** (small patch to `editor-kit.ts`, following the
existing `DriveEmbedProvider` almost line-for-line) that renders a live status card (title,
code, revision, `StatePresenter` badge) when a document link is pasted or embedded — a visual
upgrade over the already-working `@mention`, not a new capability, and cheap enough to be a single
well-isolated commit. Process-flow diagrams and any genuinely novel inline-interactive widget
should wait until there's a concrete pilot need, given the CORE PATCH cost confirmed above.

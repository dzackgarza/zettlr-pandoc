> From: https://chatgpt.com/c/6a96227c-517c-83e9-973c-10d4fe919f24

# you asked

message time: 2026-09-01 08:55:22

Look at my fork work onhttps://github.com/dzackgarza/zettlr-pandoc

I want a way to add comments or annotations to specific pieces of text, that an AI can act on. This should integrate with the existing editing API (only on the fork) and ideally reuse the infra and extend it. Also need to pin down what the appropriate UI should look like

---

# chatgpt response

I’ll inspect the fork’s editing API and recent changes, then design an annotation model that reuses that infrastructure and pin down the corresponding editor UI.

---

# chatgpt response

The review layer already supplies durable sidecars, stable suggestion identities, and anchors that survive edits. I’m tracing storage, OpenAPI, and CodeMirror to make annotations first-class entities sharing that machinery.

---

# chatgpt response

Annotations need an independent lifecycle from active reviews, with transitions handled in the existing pure state layer. UI-wise, I’m favoring margin markers plus one focused inspector.

---

# chatgpt response

# Recommended design

On the current `develop`, this should be implemented as a **durable document annotation**, not as another kind of `ReviewSuggestion`.

A `ReviewSuggestion` has proposal ownership, a source packet, restoration data, and the terminal states `accepted`, `rejected`, or `withdrawn`. The fork now deliberately guarantees that only agent-proposed text enters that adjudication lifecycle. A free-standing annotation has none of those semantics: it may exist before any proposal, it may request an explanation rather than an edit, and it must not acquire Accept/Reject controls merely because it targets text.  

The infrastructure to reuse is nevertheless substantial:

- stable entity identities and mapped anchors;
- provider-authoritative state;
- the per-document mutation lock;
- pure transitions followed by persist → commit → emit → broadcast;
- durable, validated, write-through sidecars;
- OpenAPI-generated wire types;
- CodeMirror state fields, decorations, and provider broadcasts.

The current `ReviewApplicationService` is especially important: it already gives every review writer one per-document serialization point and refuses to commit state unless persistence succeeds. An annotation implementation must enter that same transaction boundary; a second independent annotation service or sidecar would permit failures such as “proposal applied, annotation linkage not persisted.” 

## 1. Domain model

I would use **annotation** for the stable targeted entity and **message** for one comment in its conversation.

```ts
export type AnnotationAnchor =
  | {
      state: "range";
      from: number;
      to: number;
      /** Immutable text selected when the annotation was created. */
      quotedText: string;
    }
  | {
      state: "point";
      at: number;
      quotedText: string;
      reason: "target-deleted";
    }
  | {
      state: "orphaned";
      quotedText: string;
      reason: "external-drift" | "document-moved-without-reattachment";
    };

export type AnnotationResolution =
  | { state: "open" }
  | {
      state: "resolved";
      resolvedAt: string;
      resolvedBy: "owner";
    };

export type AnnotationMessage =
  | {
      messageId: string;
      author: "owner";
      text: string;
      createdAt: string;
    }
  | {
      messageId: string;
      author: "agent";
      clientRequestId: string;
      text: string;
      createdAt: string;
    };

export interface AnnotationProposalAction {
  kind: "proposal";
  reviewId: string;
  packetId: string;
  linkedAt: string;
}

export interface TextAnnotation {
  annotationId: string;
  anchor: AnnotationAnchor;
  resolution: AnnotationResolution;
  messages: [AnnotationMessage, ...AnnotationMessage[]];
  actions: AnnotationProposalAction[];
  createdAt: string;
  updatedAt: string;
}
```

Several distinctions here are essential.

### The annotation is not the selected text

The annotation has stable identity even when its text moves, changes, or is deleted. The selection is merely its current target.

### The first message is the instruction

There should not be parallel `body`, `comment`, and `description` fields. The first owner message is the initial instruction; later owner or agent messages form the thread.

### Resolution is owner-controlled

The AI may reply or submit a linked proposal. It may not resolve, reopen, delete, or reattach an annotation. This preserves the same ownership boundary already used for review adjudication: the agent proposes or communicates; the document owner disposes.

There should be no stored `addressed` boolean. “The agent replied,” “a proposal is pending,” and “all linked suggestions were accepted” are facts derivable from messages, packet links, and review state. None is equivalent to the owner deciding that the annotation is resolved.

### Proposal linkage belongs at packet level

The current API creates one packet per logical claim, while one claim may partition into several independently adjudicable suggestions. Therefore an annotation should link to the packet that represents the AI’s claimed response, not arbitrarily to one resulting suggestion. 

The UI can derive the packet’s current suggestion counts:

```text
Proposal pending: 2 suggestions
Proposal settled: 2 accepted
Proposal settled: 1 accepted, 1 rejected
Proposal withdrawn
```

When the review itself is closed and its full ledger is discarded, the annotation should retain a compact terminal outcome snapshot so that its action history does not become a dead packet ID.

## 2. Anchor semantics

The current `mapSuggestionThroughChanges` must **not** be reused literally. It contains proposal-specific behavior: owner insertions inside a suggestion are deliberately excluded from the suggestion, and overlapping replacements alter the text that Reject must restore. Those are correct adjudication rules but incorrect ordinary annotation rules. 

Extract the low-level change enumeration and position helpers, then keep two explicit functions:

```ts
mapSuggestionThroughChanges(...)
mapAnnotationThroughChanges(...)
```

Do not introduce a generic policy object with a collection of behavioral flags; these are two different mathematical transformations with independently testable semantics.

The annotation mapping should be:

| Document operation | Annotation result |
|---|---|
| Insert/delete strictly before target | Shift target |
| Insert exactly at start | Keep insertion outside target |
| Insert exactly at end | Keep insertion outside target |
| Insert inside target | Expand target to include inserted text |
| Replace part of target | Target the replacement |
| Delete part of target | Shrink target |
| Delete all target text | Collapse to a point at the deletion seam; retain thread and quoted text |
| Edit unrelated text after target | No change |
| External disk replacement with no transaction map | Mark orphaned; never guess |
| Reattach command | Replace orphaned/point target with the newly selected range |

Thus boundary mapping should use the familiar start-right/end-left association, while interior edits remain inside the target. A nonempty selection is required at creation; point annotations are produced only by later deletion.

A text edit must never silently delete an annotation. Complete deletion produces a point target because the former location is still known. `orphaned` is reserved for cases where no trustworthy positional map exists, principally external drift while detached.

Overlapping annotations must be allowed. The current review-sidecar validator correctly prohibits two outstanding suggestions from owning the same characters, but that invariant is specific to adjudicable proposals and must not be inherited by annotations. 

A linked proposal introduces one additional obligation:

- accepting a replacement leaves the annotation on the accepted replacement;
- rejecting the proposal restores the annotation’s pre-proposal target;
- accepting a deletion leaves the annotation at the deletion seam;
- rejecting that deletion restores its prior range.

The proposal transaction should therefore retain enough pre-action anchor information to make rejection exact rather than heuristically reattaching by quote.

## 3. Persistence and transaction ownership

The current sidecar is one validated JSON document per reviewed file, stored in Electron application data rather than in the workspace. It is keyed by a hash of the canonical path, contains the complete working text, and is written atomically through on review mutations. 

Annotations should turn this into a **document-collaboration sidecar**, not create a second file:

```ts
interface DocumentCollaborationSidecar {
  version: 5;
  documentPath: string;
  workingText: string;
  diskFenceSha256: string;

  review: PersistedReviewState | null;

  annotations: {
    generation: number;
    items: TextAnnotation[];
  };

  pendingSave:
    | null
    | {
        beforeDiskSha256: string;
        afterDiskSha256: string;
      };
}
```

The existing TypeBox/Ajv arrangement should remain the single runtime/type declaration. The present schema refuses unknown fields and supports one exact version, so annotations necessarily require a new schema version. 

Because a version-4 sidecar has a unique interpretation in version 5—its review is preserved and `annotations.items = []`—a deterministic v4→v5 lift is available. This is unlike fuzzy anchor migration and does not introduce ambiguity.

### One aggregate, two generations

Keep separate counters:

```ts
reviewGeneration
annotationGeneration
```

A mere annotation reply should not make an otherwise-current review decision stale. Conversely, a review comment should not invalidate an annotation reply. Both sections nevertheless live in one sidecar and are committed under the same per-document mutex.

Submitting a proposal that addresses annotations is a cross-section transaction:

1. validate document revision;
2. validate review generation;
3. validate annotation generation;
4. validate every annotation ID is open and belongs to this document;
5. prepare the patch, packets, suggestions, and annotation action links;
6. persist the one next sidecar;
7. commit the working text and both state sections;
8. emit and broadcast.

There must be no state in which only one half is visible.

### Sidecar lifetime

The current review sidecar can disappear when a review completes. The collaboration sidecar must remain while either of these is present:

```text
active review
OR
at least one annotation, open or resolved
```

Open annotations must **not** block document saving. They are metadata, not undecided text mutations.

A resolved annotation should remain until explicitly deleted or until a documented retention rule removes it. Hiding resolved annotations in the UI is not the same operation as discarding their state.

### Locality

Reusing the current app-data sidecar makes annotations private to the local Zettlr profile. That is the appropriate default for AI instructions: they do not enter Markdown, Pandoc input, exports, Git diffs, or collaborators’ clones.

Encoding them as HTML comments, CriticMarkup, footnotes, or Pandoc spans would be the wrong default. It would mutate the document being discussed, expose instructions to exports and ordinary text transformations, and make proposal patches modify annotation representation itself.

### Rename handling

Because sidecars are currently keyed by a hash of the resolved path, file rename or move must re-key and rewrite the sidecar atomically. Long-lived annotations make this a normal lifecycle operation rather than an edge case. Symlink aliases should either remain explicitly distinct or be normalized by a deliberate switch to `realpath`; the current store already records this distinction as unresolved. 

## 4. Agent API

The OpenAPI document should remain the authority, with generated TypeScript wire types and runtime conformance. The current API already separates the public wire contract from mutable internal state and teaches the agent that it may propose, comment, or retract but not adjudicate. 

I would add these reads:

```http
GET /v1/annotations?state=open
GET /v1/documents/{documentId}/annotations
GET /v1/annotations/{annotationId}
```

The global route lets an AI discover outstanding work without opening and scanning every document. Each result should carry:

```ts
interface AnnotationResponse {
  annotationId: string;
  documentId: string;
  documentPath: string;
  annotationGeneration: number;
  resolution: AnnotationResolution;
  target:
    | {
        state: "range";
        from: { offset: number; line: number; column: number };
        to: { offset: number; line: number; column: number };
        quotedText: string;
        currentText: string;
      }
    | {
        state: "point";
        at: { offset: number; line: number; column: number };
        quotedText: string;
        reason: "target-deleted";
      }
    | {
        state: "orphaned";
        quotedText: string;
        reason: string;
      };
  messages: AnnotationMessage[];
  actions: AnnotationActionResponse[];
}
```

Offsets are useful for exact machine correlation; line and column are useful for agent-readable presentation. They must be explicitly documented as CodeMirror/JavaScript UTF-16 positions rather than byte offsets.

The AI needs one annotation-specific write:

```http
POST /v1/annotations/{annotationId}/messages
```

```ts
interface AddAnnotationMessageRequest {
  expectedAnnotationGeneration: number;
  clientRequestId: string;
  text: string;
}
```

`clientRequestId` makes retry behavior idempotent. Reusing it with different text is an idempotency conflict.

The existing proposal request should become:

```ts
interface ProposalClaim {
  description: string;
  patch: string;

  /**
   * Required, possibly empty. Every annotation this logical claim answers.
   */
  addressesAnnotationIds: string[];
}

interface SubmitProposalRequest {
  baselineSha256: string;
  expectedReviewGeneration: number;
  expectedAnnotationGeneration: number;
  clientRequestId: string;
  claims: ProposalClaim[];
}
```

Requiring `addressesAnnotationIds`, with `[]` for an unrelated proposal, avoids an omitted/empty ambiguity. The proposal request fingerprint must include both the annotation generation and each claim’s ordered annotation-ID list; otherwise one `clientRequestId` could replay a patch while silently changing what it claims to answer.

Add explicit errors:

```text
ANNOTATION_NOT_FOUND
ANNOTATION_GENERATION_MISMATCH
ANNOTATION_RESOLVED
ANNOTATION_ORPHANED
```

A proposal may not claim to address an orphaned annotation until the owner reattaches it. An agent may still post a message explaining that it cannot act because the target is unavailable.

Add events such as:

```text
annotation.created
annotation.changed
annotation.message-added
annotation.resolved
annotation.reopened
annotation.orphaned
annotation.linked
```

The OpenAPI working-loop instructions should say:

1. enumerate open annotations;
2. read the current working document and annotation generation;
3. either reply or submit minimal claims listing the annotation IDs addressed;
4. never resolve or reattach an owner annotation;
5. after a stale-generation or revision refusal, reread rather than retrying unchanged.

Owner-side creation, resolution, reopening, deletion, and reattachment should remain typed renderer IPC commands rather than agent-facing HTTP operations.

## 5. UI to ship

The existing application already has a persistent right sidebar with tab infrastructure for the table of contents, references, related files, and attachments. An **Annotations** tab belongs there.  

### Creation interaction

The primary gesture should be:

1. select nonempty source text;
2. invoke **Add AI annotation** from the editor context menu or command palette;
3. reveal the right sidebar and switch it to **Annotations**;
4. create a draft card containing the selected quote and a multiline textarea;
5. submit with the visible button or `Mod-Enter`; cancel with `Escape`.

The draft target should live in a CodeMirror state field and map through transactions while the user writes the comment. It should not be represented merely by the original integer offsets captured when the command opened.

A configurable shortcut may use the conventional comment binding after the existing keymap is checked for conflicts. The context-menu command must exist regardless; the feature should not be discoverable only through a shortcut.

### Editor rendering

Use three declarative CodeMirror surfaces:

- a non-layout-changing `Decoration.mark` for the target text;
- a custom comment-bubble gutter marker on the first target line;
- a tooltip for a compact preview on hover or keyboard focus.

CodeMirror directly supports mapped decoration sets, custom gutters, and position-anchored tooltips. These should be supplied through editor state rather than by mutating the editor DOM. ([CodeMirror](https://codemirror.net/docs/ref/?utm_source=chatgpt.com))

Recommended visual states:

| State | Editor appearance |
|---|---|
| Open, inactive | Thin dotted underline; comment bubble in gutter |
| Open, active | Light background plus solid underline |
| Several annotations overlap | One gutter bubble with count; active target receives foreground styling |
| Point target | Hollow bubble at deletion seam |
| Orphaned | No text decoration; warning card remains in sidebar |
| Resolved | Hidden by default; visible when “Show resolved” is enabled |

Do not insert one full-width block widget under every annotation. The current review extension does that because Accept/Reject is an immediate, local adjudication operation and must remain visible beside the proposed change. Ordinary annotations may be numerous and long-lived; block controls would continuously alter document height and make editing unstable. The current review plugin’s block controls should remain review-specific. 

### Sidebar card

```text
┌─ Annotations ─────────────────────────────┐
│ Open 2       Resolved 4                   │
│                                           │
│ “The period map is finite near …”         │
│ You · 08:42                               │
│ This needs a precise justification and a  │
│ reference to the extension theorem.       │
│                                           │
│ AI · 08:44                                │
│ I submitted one claim adding the missing  │
│ hypothesis and citation.                  │
│                                           │
│ [1 proposal pending]  [Show proposal]     │
│                                           │
│ Reply…                                    │
│                           [Resolve] [⋯]    │
└───────────────────────────────────────────┘
```

Each card should provide:

- the current selected text, with the original quote available when it differs;
- the message thread;
- AI-action chips;
- `Show proposal`;
- owner reply;
- `Resolve`;
- overflow actions for `Reattach` and `Delete`.

Clicking either the range or the card activates both, centers the target in the editor, and focuses the card. Cards should be ordered by current document position, with orphaned annotations collected in a clearly marked section.

### Relation to the existing review UI

Accept and Reject must remain in the existing review-chunk controls. The annotation sidebar must not become a second adjudication surface.

A linked annotation displays only:

```text
Proposal pending — Show
Proposal partially accepted — Show
Proposal rejected
Proposal accepted — Resolve annotation?
```

Even when every linked suggestion is accepted, the annotation remains open until the owner selects Resolve. A correct textual edit may still fail to answer the mathematical concern.

When a linked proposal is rejected or withdrawn, the annotation remains open and the thread remains available for another agent response.

## 6. Exact integration seams

| Current area | Required change |
|---|---|
| `source/types/common/review-domain.ts` | Keep `ReviewSuggestion` unchanged; place annotation types in a new `annotation-domain.ts`. Add annotation IDs to packet-facing claim metadata, not suggestion ownership. |
| `source/common/util/review-suggestion-anchors.ts` | Extract common change-range primitives; add a separate `mapAnnotationThroughChanges`. |
| `source/app/service-providers/documents/review-application-service.ts` | Generalize to a document-collaboration application service, or extract its mutex/transaction coordinator and make both review and annotation mutations use it. |
| `review-sidecar-schema.ts` and `review-sidecar-store.ts` | Replace the review-only persisted root with a versioned collaboration root containing nullable review state and durable annotations. Preserve TypeBox/Ajv validation and atomic writes. |
| `review-transitions.ts` | Validate and atomically persist annotation links during proposal submission and retraction/adjudication. |
| New `annotation-transitions.ts` | Pure create, message, resolve, reopen, reattach, delete, map-through-edit transitions. |
| `source/app/service-providers/agent-api/openapi.yaml` | Add annotation resources, generations, events, errors, message operation, and claim linkage; regenerate wire types. |
| `source/app/service-providers/agent-api/http-server.ts` | Implement only the operations declared by OpenAPI and route them through the shared application service. |
| New `source/common/modules/markdown-editor/plugins/text-annotations.ts` | State field, mapped targets, mark decorations, gutter markers, hover/focus tooltip, navigation, and draft target. |
| `source/common/modules/markdown-editor/index.ts` | Install/reconfigure the annotation extension from provider broadcasts and expose create/jump/reattach editor commands. |
| New `source/win-main/sidebar/AnnotationsTab.vue` | Thread list, draft composer, filters, action links, resolution and reattachment controls. |
| `source/win-main/sidebar/MainSidebar.vue` | Register the Annotations tab and its open-count badge. |

The existing files already separate the store, pure transitions, application service, sidecar schema/store, HTTP adapter, shared types, and CodeMirror view. The new feature should preserve that separation rather than putting annotation mutation logic into the Vue component or editor plugin. 

## 7. Non-negotiable proof obligations

| Invariant | Required proof |
|---|---|
| Annotation independence | Create, read, resolve, close, reopen, and restart with no active review |
| No adjudication leakage | No annotation ever appears in Accept/Reject enumeration |
| No save gate | Saving succeeds with any number of open annotations and no unresolved suggestions |
| Mapping correctness | Exhaustive tests for boundary insertion, interior insertion, replacement, partial deletion, total deletion, undo, and redo |
| No silent loss | Every complete deletion yields a point target; every unmappable external change yields an orphan |
| Exact rejection | Rejecting a linked proposal restores both document text and the pre-proposal annotation target |
| Atomic linkage | Injected persistence failure leaves neither patch nor annotation action link committed |
| Concurrency | Stale annotation generation rejects without changing document, review, thread, or events |
| Idempotency | Replayed agent message and replayed linked proposal return the original result exactly once |
| Permissions | Agent routes cannot resolve, reopen, reattach, delete, accept, or reject |
| Restart fidelity | Sidecar restoration reproduces IDs, ranges, messages, resolution states, and action links |
| Multi-pane consistency | Two views of one document receive one authoritative annotation state and select the same targets |
| Overlap | Overlapping annotations remain independent and render deterministically |
| External drift | No quote search or fuzzy reattachment occurs |
| Contract parity | OpenAPI, generated types, runtime operation table, errors, and events are exact matches |
| UI journey | E2E: select → annotate → API read → AI proposal → show proposal → accept → resolve → restart |

## Final decision

The feature should be:

> **A provider-owned, sidecar-persisted `TextAnnotation` thread attached to a mapped document range, exposed to agents as a readable task that may receive replies or packet-linked proposals, and presented to the user through a new right-sidebar tab plus lightweight editor marks and gutter markers.**

It should reuse the review system’s authority, transaction ordering, sidecar validation, entity identity, OpenAPI generation, and CodeMirror projection pattern. It should **not** reuse the `ReviewSuggestion` lifecycle, the proposal-specific anchor mapper, the save gate, or the full-width Accept/Reject widget.

---

# you asked

message time: 2026-09-01 09:27:34

Generate a few images of what a great UI for this might look like

---

# chatgpt response

![image](https://chatgpt.com/backend-api/estuary/content?id=file_00000000fe18820680ba6c3fdaefbf34&ts=496730&p=fs&cid=1&sig=0a89e4a5770056e4f9f6dab494f7a95f53182ec3c7ace5bb2bbf40e5cf2961eb&v=0)

![image](https://chatgpt.com/backend-api/estuary/content?id=file_00000000dbdc82068890b67db86db3ad&ts=496730&p=fs&cid=1&sig=a6ea65383f177b9d70cc442d9f376a3971b2ed63e4f0504477531b9b75eed09e&v=0)

![image](https://chatgpt.com/backend-api/estuary/content?id=file_000000007c888209ab464d3a7ac81185&ts=496730&p=fs&cid=1&sig=5deea1626299f5f3012c4029005fea6a267133c85964385c40be54a419ee6905&v=0)

![image](https://chatgpt.com/backend-api/estuary/content?id=file_000000008a6c81f4829fbf2963dfd32b&ts=496730&p=fs&cid=1&sig=a37823eca68f31250f14137fb5b1ec27cb88d21919898819e43297101127725a&v=0)

---

# you asked

message time: 2026-09-01 09:36:45

Now describe what's need on my fork to help the UI converge to something like this. Provide implementation plan details

---

# chatgpt response

I’ll map the target UI onto the fork’s editor, sidebar, review state, sidecar, IPC, and OpenAPI seams, then give an ordered file-level plan with test gates.

---

# chatgpt response

The shell already fits: CodeMirror handles local rendering and the right sidebar is established. The main gap is a durable annotation projection spanning marks, gutters, and sidebar.

---

# chatgpt response

Standalone annotations need their own pre-review state, not relocated proposal comments. I’ll build this in vertical slices, while adding sidebar width safeguards and editor↔sidebar selection synchronization.

---

# chatgpt response

# Recommended direction

The fork should converge toward the mockups by adding a **document-collaboration layer** to the existing Zettlr shell, not by rebuilding the shell itself.

The application already has the correct high-level structure: a file manager, a central editor, and a persistent resizable right sidebar. The right sidebar already uses a tabbed `MainSidebar`, so the principal UI addition is a fifth **Annotations** tab, not a new pane manager or global redesign.  

The existing review implementation also already supplies most of the difficult machinery:

- authoritative main-process review state;
- stable suggestion identities;
- mapped anchors through owner edits;
- sidecar persistence;
- generation and working-text fences;
- atomic persist-before-commit mutations;
- inline changed-text and deleted-text rendering;
- typed renderer IPC and an OpenAPI agent interface.

What is missing is a durable annotation entity independent of a proposal, a shared renderer projection for both the editor and sidebar, and the inspector-style UI shown in the mockups.

## 1. Target UI

The best target is a combination of the generated concepts:

- the fourth image’s annotation list plus selected-detail inspector;
- the second image’s selection-anchored creation composer;
- the third image’s threaded discussion and proposal summary;
- the first image’s relatively restrained visual styling.

Do not copy the mockups’ generic application chrome, user avatars, sharing controls, or invented collaborator system. Zettlr-Pandoc should retain its existing toolbar, file manager, editor typography, and platform styling.

### Right-sidebar structure

Add an `annotations` entry to `MainSidebar.vue`:

```text
Annotations
├── Header
│   ├── Open count
│   ├── All / Open / Resolved
│   └── overflow menu
├── Annotation list
└── Selected annotation inspector
    ├── source excerpt
    ├── message thread
    ├── linked proposal status
    ├── reply composer
    └── Resolve / Reattach / Delete
```

The existing sidebar currently has four fixed tabs and one scroll container. Its structure is already suitable, but `AnnotationsTab.vue` should own its own scrolling and sticky regions rather than inherit the generic padded container indiscriminately. 

The responsive behavior should be:

- **Wide sidebar:** list and detail visible together, either side-by-side or with a compact list above the inspector.
- **Normal sidebar:** list above, selected detail below.
- **Narrow sidebar:** list and detail become two navigable views; selecting a card drills into the detail, with a Back button.

Use a CSS container query rather than viewport width because the sidebar is user-resizable.

### Sidebar tab badge

Extend `TabbarControl` with an optional badge and complete ARIA state:

```ts
export interface TabbarControl {
  icon?: string;
  id: string;
  target: string;
  label: string;
  badge?: number;
}
```

`TabBar.vue` should also expose:

```vue
:aria-selected="currentTab === tab.id"
:aria-controls="tab.target"
```

The current component already uses `role="tablist"` and `role="tab"`, but it has no badge and does not expose selection or controlled-panel state. 

The annotation badge should count **open owner annotations**, not unresolved review suggestions. Review suggestions can have a separate count inside the tab.

### Editor rendering

Add a separate CodeMirror annotation extension with:

- a subtle range decoration for every open annotation;
- stronger styling for the active annotation;
- a custom gutter marker on the first covered line;
- a count marker when several annotations begin on the same line;
- a point marker for an annotation whose entire target was deleted;
- no editor decoration for an orphaned annotation;
- resolved annotations hidden unless “Show resolved” is enabled.

Use:

```ts
Decoration.mark(...)
gutter(...)
GutterMarker
StateField
StateEffect
showTooltip
```

Do not render whole discussion threads or action strips inside the editor. The sidebar owns the thread and proposal actions.

### Creation interaction

The final creation flow should be:

1. The owner selects nonempty text.
2. They invoke **Annotate for AI…** from the context menu or shortcut.
3. A compact composer opens adjacent to the selection when space permits.
4. The composer displays the selected excerpt and one instruction field.
5. `Mod-Enter` creates the annotation; `Escape` cancels and restores editor focus.
6. The sidebar opens to the new annotation.

The current context-menu handler automatically selects the clicked word when no explicit selection exists. The annotation command must be inserted before that fallback and must only be offered for a genuinely nonempty pre-existing selection; otherwise a context click would silently create an annotation on an arbitrary word. 

Internally, use one `AnnotationDraftController`. It can present:

- a CodeMirror-anchored tooltip in a sufficiently wide editor;
- the same draft in the sidebar on narrow layouts or when the tooltip would be clipped.

The draft range must map through editor transactions while the composer is open. Capturing the initial integer offsets and retaining them unchanged is insufficient.

### Annotation detail

The selected detail should contain:

```text
SOURCE
“The exact currently targeted passage…”

YOU · timestamp
Please justify this and add a precise reference.

AI · timestamp
The statement needs hypothesis X. I submitted a revision.

[1 proposal pending]  [Show proposal]

Reply…
[Reattach] [Resolve] [⋯]
```

Do not store or display a synthetic title as required data. A compact list title can be derived from:

1. the first sentence of the owner’s initial message;
2. otherwise the quoted target text.

The UI should distinguish:

- original quoted text;
- current target text, when it has changed;
- current line location;
- target state: range, point, or orphaned.

## 2. Introduce a real annotation domain

A current review comment is attached to an outstanding suggestion. It is not a free-standing annotation on arbitrary document text. The review domain also associates suggestions with proposal packets, restoration text, adjudication state, and Accept/Reject semantics. Those are inappropriate for a user-created instruction that may request an explanation without requesting any textual edit. 

Create:

```text
source/types/common/annotation-domain.ts
source/types/common/document-collaboration.ts
```

The core types should be approximately:

```ts
export type AnnotationAnchor =
  | {
      state: 'range';
      from: number;
      to: number;
      quotedText: string;
    }
  | {
      state: 'point';
      at: number;
      quotedText: string;
      reason: 'target-deleted';
    }
  | {
      state: 'orphaned';
      quotedText: string;
      reason: 'external-drift' | 'unmapped-document-change';
    };

export type AnnotationMessage =
  | {
      messageId: string;
      author: 'owner';
      text: string;
      createdAt: string;
    }
  | {
      messageId: string;
      author: 'agent';
      text: string;
      createdAt: string;
      clientRequestId: string;
    };

export interface AnnotationProposalAction {
  actionId: string;
  packetId: string;
  reviewId: string;
  linkedAt: string;
  terminalOutcome?:
    | 'accepted'
    | 'rejected'
    | 'mixed'
    | 'withdrawn'
    | 'cleared';
}

export interface TextAnnotation {
  annotationId: string;
  documentId: string;
  anchor: AnnotationAnchor;
  state: 'open' | 'resolved';
  messages: [AnnotationMessage, ...AnnotationMessage[]];
  proposalActions: AnnotationProposalAction[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}
```

Important invariants:

- `quotedText` is immutable and records what the owner selected at creation.
- The current target text is computed from the live document and current anchor.
- The first owner message is the initial instruction; there is no parallel `body` or `description`.
- The owner alone resolves or reopens an annotation.
- The agent may reply, submit linked proposals, or retract its own unresolved packet.
- There is no stored `addressed: boolean`.
- Proposal state is orthogonal to annotation resolution.
- One claim may address several annotations.
- One annotation may be addressed by several claims over time.
- Proposal linkage is to the claim packet, not to one arbitrarily chosen resulting suggestion.

The packet-level linkage matters because the current domain separates a proposal packet from the resulting independently adjudicable suggestions. 

### Annotation state machine

```text
draft
  └── create ──> open/range

open/range
  ├── target fully deleted ──> open/point
  ├── unmappable external change ──> open/orphaned
  └── resolve ──> resolved

open/point
  ├── reattach ──> open/range
  ├── unmappable external change ──> open/orphaned
  └── resolve ──> resolved

open/orphaned
  ├── reattach ──> open/range
  └── resolve ──> resolved

resolved
  └── reopen ──> open

any persisted state
  └── delete ──> absent
```

A target deletion must not silently delete the annotation. It leaves a point target at the deletion seam.

## 3. Do not reuse the suggestion mapper unchanged

Extract the common change enumeration and position-mapping primitives, but implement a separate:

```ts
mapAnnotationThroughChanges(...)
```

The existing `mapSuggestionThroughChanges` deliberately excludes owner insertions inside agent-authored text and absorbs overlapping replacements so that Reject can restore the correct reference text. Those are proposal-adjudication semantics, not ordinary comment-anchor semantics. 

Annotation mapping should instead obey:

| Edit | Annotation result |
|---|---|
| Insert before target | Shift range |
| Insert at range start | Keep insertion outside |
| Insert inside range | Expand range to include insertion |
| Insert at range end | Keep insertion outside |
| Replace part of range | Target replacement text |
| Delete part of range | Shrink range |
| Delete entire range | Collapse to point at deletion seam |
| Edit after range | No change |
| External change without an exact transaction map | Mark orphaned |

Overlapping annotations must be permitted. The review-sidecar rule prohibiting overlapping outstanding suggestion ownership must remain review-specific.

Create:

```text
source/common/util/annotation-anchors.ts
source/app/service-providers/documents/annotation-transitions.ts
```

`annotation-transitions.ts` should contain pure operations:

```ts
prepareAnnotationCreation(...)
prepareAnnotationMessage(...)
prepareAnnotationResolution(...)
prepareAnnotationReopen(...)
prepareAnnotationReattachment(...)
prepareAnnotationDeletion(...)
prepareAnnotationMappingThroughOwnerEdit(...)
```

No Vue, Electron, filesystem, event emission, or mutable store access should occur inside these functions.

## 4. Replace review-only persisted state with a collaboration aggregate

The present sidecar is versioned, TypeBox/Ajv-validated, atomically written, and contains the working text and disk fence needed for restart restoration. That mechanism should be generalized rather than duplicated.  

The new persisted root should be:

```ts
export interface DocumentCollaborationSidecar {
  version: 5;
  documentPath: string;
  workingText: string;
  diskFenceSha256: string;

  review: PersistedReviewState | null;

  annotations: {
    generation: number;
    items: TextAnnotation[];
  };

  pendingSave?: {
    beforeDiskSha256: string;
    afterDiskSha256: string;
  };
}
```

The current version-4 sidecar has an unambiguous migration:

```ts
{
  ...version4Fields,
  version: 5,
  review: migratedVersion4Review,
  annotations: {
    generation: 0,
    items: []
  }
}
```

Read both versions; write only version 5.

### Persistence lifetime

Persist the sidecar whenever:

```ts
review !== null || annotations.items.length > 0
```

This changes several existing lifecycle rules:

- Completing a review must not delete the sidecar when annotations remain.
- Open annotations must not prevent saving.
- Closing a document must persist annotations even when no review exists.
- Reopening an unchanged document restores exact anchors and threads.
- If an annotation-only sidecar encounters external disk drift, open the current disk content and mark its annotations orphaned rather than replacing the file with stale sidecar working text.
- If a review and annotations coexist during external drift, invalidate the review according to its existing rules while preserving the annotation threads as orphaned.
- Renaming a document must atomically re-key the path-hashed sidecar.

Annotations should remain in app-data sidecars. They should not be encoded as HTML comments, CriticMarkup, Markdown spans, footnotes, or frontmatter because those forms contaminate document content, Pandoc exports, Git diffs, and ordinary text transformations.

## 5. One application service and one document lock

Do not add an independent `AnnotationApplicationService` with its own mutex and sidecar writes.

The current review application service already defines the correct mutation sequence:

1. acquire the document lock;
2. validate generation, working hash, and disk fence;
3. prepare a pure transition;
4. persist the next sidecar;
5. replace committed state;
6. commit the working-text replacement;
7. emit events;
8. broadcast the next renderer projection.

That ordering must govern review and annotation state together. 

Rename or evolve it into:

```text
document-collaboration-application-service.ts
```

with one aggregate:

```ts
interface ActiveDocumentCollaboration {
  documentId: string;
  documentPath: string;
  workingText: string;
  diskFenceSha256: string;
  review?: ActiveReviewState;
  annotations: {
    generation: number;
    items: TextAnnotation[];
  };
}
```

Keep separate counters:

```ts
reviewGeneration: number;
annotationGeneration: number;
```

A reply to an annotation should not stale an otherwise-current Accept/Reject decision. A review-level comment should not stale an annotation reply. Operations touching both sections—most importantly an annotation-linked proposal—validate and advance both as appropriate in one transaction.

`DocumentManager` already owns the typed renderer handlers, the review application service, agent events, and document identity resolution. That is the correct integration point for the new collaboration aggregate and owner-side IPC.  

## 6. Add one authoritative renderer snapshot

The current renderer model sends a `ReviewDiffSession` to editor panes. The sidebar would need the same information, plus annotations, packet state, messages, timestamps, and selection state.

Introduce:

```ts
export interface DocumentCollaborationSession {
  documentId: string;
  documentPath: string;
  workingSha256: string;

  annotationGeneration: number;
  annotations: AnnotationView[];

  review?: {
    reviewId: string;
    generation: number;
    unresolvedSuggestions: ReviewSuggestionView[];
    packets: ReviewPacketView[];
    comments: ReviewCommentView[];
  };
}
```

Add a full-snapshot event:

```ts
DP_EVENTS.DOCUMENT_COLLABORATION
```

Do not independently broadcast one shape to CodeMirror and another to the sidebar. The renderer flow should be:

```text
Document provider
    │
    ├── full DocumentCollaborationSession broadcast
    ▼
Pinia document-collaboration-store
    ├── MainEditor watches active document snapshot
    └── AnnotationsTab watches the same snapshot
```

Create:

```text
source/pinia/document-collaboration-store.ts
```

It should hold:

```ts
sessionsByDocumentPath
selectedEntityByWindow
draftByEditorView
showResolvedByWindow
inspectorModeByWindow
```

Only `selectedEntity`, draft presentation, filters, and local focus state belong to Pinia. Annotation entities and review entities remain provider-authoritative.

A background agent response should update the store and badge but should not steal focus, switch tabs, or open the sidebar. Explicit user actions—creating an annotation, clicking a gutter marker, or selecting “Show proposal”—may do so.

## 7. Owner-side IPC

Extend the typed `DocumentIpcHandlers` contract currently used for review decisions and comments. 

Add:

```ts
'documents:get-collaboration-session'
'documents:create-annotation'
'documents:add-annotation-message'
'documents:resolve-annotation'
'documents:reopen-annotation'
'documents:reattach-annotation'
'documents:delete-annotation'
```

Creation should carry:

```ts
interface CreateAnnotationInput {
  documentPath: string;
  from: number;
  to: number;
  text: string;
  expectedWorkingSha256: string;
  expectedAnnotationGeneration: number;
  clientRequestId: string;
}
```

The main process must derive `quotedText` from its own authoritative working text and verify:

```ts
0 <= from < to <= workingText.length
```

It should not trust a renderer-supplied quotation.

Reattachment similarly carries a new nonempty range and exact working hash.

Resolve, reopen, and delete need the annotation generation but no working hash unless they also alter the target.

Use `clientRequestId` for create and message operations so a renderer retry cannot duplicate an annotation or thread message.

## 8. Agent API

Extend the existing OpenAPI contract instead of inventing a parallel AI transport. The current contract already tells agents to orient, read current document state, submit claim-sized proposals, comment, and never adjudicate owner decisions. 

Add:

```http
GET /v1/annotations?state=open
GET /v1/documents/{documentId}/annotations
GET /v1/annotations/{annotationId}
POST /v1/annotations/{annotationId}/messages
```

The global collection is important: an agent needs to enumerate open tasks without scanning every document manually.

A response should expose both machine-exact and human-readable positions:

```ts
interface AnnotationTargetResponse {
  state: 'range';
  from: {
    offset: number;
    line: number;
    column: number;
  };
  to: {
    offset: number;
    line: number;
    column: number;
  };
  quotedText: string;
  currentText: string;
}
```

Document that offsets and columns use JavaScript/CodeMirror UTF-16 units rather than UTF-8 bytes.

Add an agent message request:

```ts
interface AddAnnotationMessageRequest {
  expectedAnnotationGeneration: number;
  clientRequestId: string;
  text: string;
}
```

Extend every proposal claim:

```ts
interface ProposalClaim {
  description: string;
  patch: string;
  addressesAnnotationIds: string[];
}
```

The field should be required, with `[]` denoting an unrelated proposal. Include it, the annotation generation, and the annotation IDs in the proposal request fingerprint.

Add errors:

```text
ANNOTATION_NOT_FOUND
ANNOTATION_GENERATION_MISMATCH
ANNOTATION_RESOLVED
ANNOTATION_ORPHANED
```

Add events:

```text
annotation.created
annotation.message-added
annotation.target-changed
annotation.orphaned
annotation.resolved
annotation.reopened
annotation.deleted
annotation.proposal-linked
```

Do not expose HTTP operations allowing the agent to:

- resolve or reopen;
- delete;
- reattach;
- accept or reject;
- clear a review.

### Atomic linked proposal

A linked proposal must execute as one transaction:

1. Validate the document baseline SHA.
2. Validate review generation.
3. Validate annotation generation.
4. Verify every addressed annotation belongs to the document.
5. Verify each is open and not orphaned.
6. Prepare patch application.
7. Create one packet per claim.
8. Record packet-to-annotation links.
9. Map all affected annotation anchors through the patch.
10. Persist one next collaboration sidecar.
11. Commit working text, review state, and annotation state.
12. Broadcast one new collaboration snapshot.

A failure at any point must leave no applied patch and no recorded annotation linkage.

## 9. CodeMirror implementation

Create:

```text
source/common/modules/markdown-editor/plugins/text-annotations.ts
```

Install it through a dedicated `Compartment`, analogous to the current review extension.

The extension should define:

```ts
setAnnotationSessionEffect
setActiveAnnotationEffect
setAnnotationDraftEffect
clearAnnotationDraftEffect
showResolvedAnnotationsEffect
```

It should maintain:

- provider-authoritative annotation ranges;
- a locally mapped draft range;
- active annotation identity;
- decoration sets;
- gutter markers;
- tooltip state.

On ordinary editor transactions, map the local projected ranges immediately to avoid flicker. The provider broadcast then replaces them with the committed authoritative snapshot.

Clicking a gutter marker should call an `AnnotationUiClient` injected into the editor wrapper:

```ts
interface AnnotationUiClient {
  selectAnnotation(annotationId: string): void;
  beginDraft(range: { from: number; to: number }): void;
}
```

Do not import Pinia into the CodeMirror plugin. `MainEditor.vue` should bridge CodeMirror callbacks to the renderer store.

For sidebar-to-editor navigation, the active `MainEditor` watches the window-local selected annotation and dispatches:

```ts
setActiveAnnotationEffect.of(annotationId)
EditorView.scrollIntoView(range, { y: 'center' })
```

The existing cross-component editor-command contract is already a prop-driven bridge with limited generic payloads. Annotation selection and draft state are richer and persistent enough that they should use the collaboration store rather than adding another series of boolean command toggles to `EditorCommands`. 

## 10. Sidebar components

Add:

```text
source/win-main/sidebar/AnnotationsTab.vue
source/win-main/sidebar/annotations/AnnotationHeader.vue
source/win-main/sidebar/annotations/AnnotationList.vue
source/win-main/sidebar/annotations/AnnotationListItem.vue
source/win-main/sidebar/annotations/AnnotationInspector.vue
source/win-main/sidebar/annotations/AnnotationThread.vue
source/win-main/sidebar/annotations/AnnotationComposer.vue
source/win-main/sidebar/annotations/ProposalActionCard.vue
source/win-main/sidebar/annotations/SuggestionInspector.vue
```

`AnnotationsTab.vue` should select one of three high-level modes:

```ts
type CollaborationInspectorMode =
  | 'annotations'
  | 'suggestions'
  | 'annotation-detail';
```

A more compact UI can expose `Annotations` and `Suggestions` as a segmented switch. The semantics remain:

- **Annotations:** owner-created tasks and conversations.
- **Suggestions:** unlinked or directly selected review suggestions.
- **Linked proposals:** shown inside the corresponding annotation detail.

### Final treatment of the current review UI

The existing review extension currently renders both the textual diff and a full block control strip after each chunk. 

The final interface should retain:

- inserted/changed text decoration;
- deleted-text rendering;
- active-chunk highlighting;
- F8/Shift-F8 navigation;
- compact gutter indication.

Move into `SuggestionInspector.vue`:

- proposal description;
- reviewer comment;
- Accept;
- Reject;
- Accept all;
- Clear review;
- packet provenance and linked annotation;
- current generation/staleness failures.

Once the inspector is complete, remove the duplicated per-chunk block controls and top review panel. There should not be two permanent adjudication surfaces.

When the sidebar is hidden, the document still visibly shows tracked changes. F8, a gutter click, or “Show proposal” can reveal the sidebar and select the appropriate suggestion.

## 11. Visual system

Do not introduce a separate purple “AI app” theme. Use existing Zettlr platform and dark-mode variables, augmented with a small collaboration token set:

```less
--annotation-accent
--annotation-accent-muted
--annotation-border
--annotation-surface
--annotation-active-surface
--annotation-warning
--annotation-resolved
--proposal-pending
```

The state cannot be encoded only by color. Every card must carry visible labels such as:

```text
Open
Resolved
Target deleted
Needs reattachment
1 proposal pending
Proposal rejected
```

Recommended styling:

- subtle dotted underline for inactive open ranges;
- light translucent fill for active range;
- one accent color for owner annotations;
- existing diff colors for proposals;
- neutral cards with small state accents;
- no full-width colored card borders except the selected item;
- sticky header and sticky action footer;
- minimal shadows, since the existing Zettlr sidebar is comparatively flat.

## 12. Concrete landing sequence

### Tranche A — collaboration domain, mapping, persistence, and transactions

Implement:

```text
annotation-domain.ts
document-collaboration.ts
annotation-anchors.ts
annotation-transitions.ts
document-collaboration-sidecar-schema.ts
document-collaboration-sidecar-store.ts
document-collaboration-application-service.ts
```

Modify:

```text
review-domain.ts
documents/index.ts
review application-service imports
save/detach/reattach/rename lifecycle
owner-update transaction
```

Required outcomes:

- version-4 reviews migrate without loss;
- annotations work with no active review;
- exact local edits map anchors;
- full target deletion yields a point;
- external drift yields orphaned annotations;
- review completion preserves annotations;
- saving is never blocked by annotations;
- persistence failure commits neither document nor collaboration state.

### Tranche B — renderer projection, editor extension, and complete owner UI

Implement:

```text
document-collaboration-store.ts
text-annotations.ts
AnnotationsTab.vue and subcomponents
```

Modify:

```text
App.vue
MainEditor.vue
MainSidebar.vue
TabBar.vue
get-config-template.ts
default-context-menu.ts
shortcut registry/keymap
markdown-editor/index.ts
```

Required outcomes:

- full collaboration snapshot reaches every pane;
- editor and sidebar always display the same annotation generation;
- selection creates an annotation;
- gutter and list selections are synchronized;
- threads support owner replies;
- resolve, reopen, delete, and reattach work;
- restart reproduces the same UI state;
- narrow and dark layouts are complete.

### Tranche C — agent API and proposal linkage

Modify:

```text
source/app/service-providers/agent-api/openapi.yaml
generated API types
HTTP operation table
review proposal transitions
packet serialization
agent event emission
capabilities response
```

Required outcomes:

- agents can list, inspect, and reply to annotations;
- claims explicitly name addressed annotations;
- proposal linkage is packet-level;
- stale document, review, or annotation generations refuse atomically;
- retries are idempotent;
- agents cannot resolve or adjudicate;
- Accept, Reject, Clear, and Retract produce correct linked-action outcomes.

### Tranche D — review inspector consolidation and final polish

Modify:

```text
review-chunks.ts
review-chunks styles
SuggestionInspector.vue
ProposalActionCard.vue
capture and E2E fixtures
```

Required outcomes:

- no duplicated permanent Accept/Reject surface;
- “Show proposal” selects all suggestions belonging to the linked packet;
- current review comments remain available;
- unlinked proposals remain reviewable;
- keyboard navigation selects the matching inspector card;
- light, dark, desktop-width, and narrow-width captures match the intended hierarchy.

## 13. Required tests

The repository already routes focused tests, full tests, Electron E2E, and renderer captures through its `justfile`, and it has an existing `capture-review-diff` path. Add the annotation proof surface to the same infrastructure rather than creating ad hoc screenshot scripts.  

Add at least:

```text
test/annotation-anchors.spec.ts
test/annotation-transitions.spec.ts
test/collaboration-sidecar.spec.ts
test/document-annotation-ipc.spec.ts
test/editor-annotations.spec.ts
test/annotations-sidebar.spec.ts
test/annotation-agent-api.spec.ts
test/annotation-proposal-linkage.spec.ts
test/annotation-multi-pane.spec.ts
test/annotation-restart.spec.ts
```

Add a capture recipe:

```text
capture-annotations
```

with scenes:

1. selection composer;
2. several open annotations;
3. selected annotation thread;
4. AI reply without proposal;
5. linked proposal pending;
6. linked proposal partly accepted;
7. deleted target point;
8. orphaned target;
9. overlapping annotations;
10. resolved annotations visible;
11. narrow sidebar;
12. dark mode.

The decisive end-to-end journeys are:

```text
select → annotate → close → reopen → exact target and thread restored

annotate → owner edits before/inside target → exact mapped range

annotate → AI reads → AI replies → thread updates without focus theft

annotate → AI proposes → Show proposal → accept → owner resolves

annotate → AI proposes → reject → original text and annotation target restored

annotate → external disk drift → annotation becomes orphaned → owner reattaches

same document in two panes → one mutation → both panes and sidebar agree
```

## 14. Final completion condition

The work is complete when the fork has one coherent interaction:

> The owner selects text, records an instruction, the instruction persists independently of review state, an agent can discover it and either answer or submit an explicitly linked proposal, the editor shows the target and proposed changes without embedding metadata in Markdown, the sidebar presents the complete thread and adjudication state, and every mutation is fenced, atomic, restart-safe, and synchronized across panes.

That is the architectural change required for the generated UI to be real rather than a visual shell over the existing review system.
## Summary

This pull request implements the **document-collaboration layer and AI text annotations** system in Zettlr-Pandoc, establishing durable document annotations that integrate with the editor, right sidebar, and the OpenAPI agent API.

- **Standalone `TextAnnotation` Aggregate**: Independent lifecycle from active reviews, persisted sidecar-only in app data (`~/.config/Zettlr-Pandoc/...`) without polluting Markdown content, exports, or git diffs.
- **Unified Sidecar v5**: Generalizes `ReviewSidecarStore` into `CollaborationSidecarStore` holding nullable review state, durable annotations, working text, and disk fence hashes.
- **Provider-Authoritative Snapshot & Pinia Store**: Synchronous broadcast of `DocumentCollaborationSession` over `DP_EVENTS.DOCUMENT_COLLABORATION` driving both CodeMirror marks/gutters and the right-sidebar `AnnotationsTab`.
- **Editor Surfaces**: Lightweight background mark decorations, numbered circular gutter badges (①②③…), selection-anchored floating creation dialog modal (`AnnotationCreateDialog.vue`), and live anchor mapping through owner typing.
- **Inspector & UI Consolidation**: Two-section list+detail `AnnotationsTab.vue` in the right sidebar. Review suggestion Accept/Reject controls consolidated into sidebar `SuggestionInspector.vue`, removing duplicate in-editor block widgets.
- **OpenAPI & Agent Integration**: `/v1/annotations` collection and item endpoints, UTF-16 offset/line/column target reporting, idempotent message posting via `clientRequestId`, and atomic packet-level proposal linkage (`addressesAnnotationIds`).

---

## Architectural Invariants

1. **Owner Adjudication Boundary**: The document owner alone creates, resolves, reopens, reattaches, or deletes annotations. Agents may query, post messages, or submit linked proposals, but cannot resolve or adjudicate.
2. **Transaction & Mutex Boundary**: Single per-document mutex in `CollaborationApplicationService` executing: `read → prepare (pure transition) → PERSIST sidecar → commit in-memory → emit events → broadcast snapshot`.
3. **Dual Monotonic Generations**: Separate `reviewGeneration` and `annotationGeneration` counters prevent unrelated operations from invalidating each other.
4. **Anchor Mapping Integrity**: Local owner typing maps annotation ranges immediately without drift. Total target deletion collapses to a point at the seam retaining immutable `quotedText`; external drift marks annotations `orphaned` without silent loss or fuzzy guessing.
5. **No Save Gate**: Open annotations never block document saves.

---

## Tranche Breakdown & Work Unit Manifest

### Tranche A: Collaboration Domain, Mapping, Persistence & Transactions
- [ ] **WU-1**: Domain & Collaboration Types (`source/types/common/annotation-domain.ts`, `source/types/common/document-collaboration.ts`)
- [ ] **WU-2**: Pure Anchor Mapper (`source/common/util/annotation-anchors.ts`)
- [ ] **WU-3**: Sidecar Schema v5 & Deterministic v4→v5 Migration (`source/app/service-providers/documents/collaboration-sidecar-schema.ts`)
- [ ] **WU-4**: Collaboration Sidecar Store (`source/app/service-providers/documents/collaboration-sidecar-store.ts`)
- [ ] **WU-5**: Pure Annotation State Transitions (`source/app/service-providers/documents/annotation-transitions.ts`)
- [ ] **WU-6**: Document Collaboration Application Service (`source/app/service-providers/documents/document-collaboration-application-service.ts`)
- [ ] **WU-7**: Cross-Section Proposal Linkage (`source/app/service-providers/documents/review-transitions.ts`)

### Tranche B: Renderer Projection, Editor & Owner UI
- [ ] **WU-8**: Pinia Collaboration Store & IPC Types (`source/pinia/document-collaboration-store.ts`)
- [ ] **WU-9**: CodeMirror Text-Annotations Extension (`source/common/modules/markdown-editor/plugins/text-annotations.ts`)
- [ ] **WU-10**: Editor Wrapper & Context Menu Integration (`source/common/modules/markdown-editor/index.ts`, `plugins/default-context-menu.ts`)
- [ ] **WU-11**: Floating Selection Creation Dialog (`source/win-main/AnnotationCreateDialog.vue`)
- [ ] **WU-12**: TabBar Badging & ARIA Upgrades (`source/common/vue/TabBar.vue`, `source/types/common/tabbar.ts`)
- [ ] **WU-13**: AnnotationsTab & Inspector Subcomponents (`source/win-main/sidebar/AnnotationsTab.vue`, `sidebar/annotations/*`)
- [ ] **WU-14**: Document Manager IPC Handlers & Broadcast Wiring (`source/app/service-providers/documents/index.ts`)

### Tranche C: OpenAPI Contract & Agent HTTP API
- [ ] **WU-15**: OpenAPI YAML Schema & Endpoint Declarations (`source/app/service-providers/agent-api/openapi.yaml`)
- [ ] **WU-16**: Generated Agent API Wire Types & Aliases (`source/types/generated/agent-api.d.ts`, `source/types/common/agent-api.ts`)
- [ ] **WU-17**: HTTP Server Handlers, Concurrency Fencing & Events (`source/app/service-providers/agent-api/http-server.ts`)

### Tranche D: Review Consolidation, Lifecycle & Visual Verification
- [ ] **WU-18**: Suggestion Inspector Consolidation (`source/win-main/sidebar/annotations/SuggestionInspector.vue`, `review-chunks.ts`)
- [ ] **WU-19**: Save/Rename/Drift Lifecycle & Capture Suite (`scripts/capture-annotations.cjs`, `just capture-annotations`)

---

## Test & Verification Matrix

### 10 Targeted Spec Suites
1. `test/annotation-anchors.spec.ts`: Exhaustive boundary, interior, replacement, deletion, and undo/redo anchor mapping.
2. `test/annotation-transitions.spec.ts`: Pure state transitions (create, message, resolve, reopen, reattach, delete).
3. `test/collaboration-sidecar.spec.ts`: Sidecar v5 validation, v4→v5 deterministic lift, atomic file I/O.
4. `test/document-annotation-ipc.spec.ts`: Typed IPC requests, coordinate bounds validation, generation gating.
5. `test/editor-annotations.spec.ts`: CodeMirror mark decorations, numbered gutter markers, draft underlines.
6. `test/annotations-sidebar.spec.ts`: Vue sidebar subcomponents, container query responsive widths.
7. `test/annotation-agent-api.spec.ts`: OpenAPI conformance, UTF-16 offset/line/column output, idempotency deduplication.
8. `test/annotation-proposal-linkage.spec.ts`: Packet-level linking, cross-section transaction atomicity, rejection restoration.
9. `test/annotation-multi-pane.spec.ts`: Multi-view synchronization, broadcast event propagation.
10. `test/annotation-restart.spec.ts`: Sidecar persistence through document close/reopen and full app restart.

### Decisive E2E Journeys
- Select → annotate → close → reopen → exact target and thread restored from sidecar.
- Annotate → owner edits before/inside target → exact mapped range without drift.
- Annotate → agent reads → agent replies → thread updates live without focus theft.
- Annotate → agent proposes → Show proposal → accept → owner resolves.
- Annotate → agent proposes → reject → original text and annotation target restored.
- Annotate → external disk drift → annotation becomes orphaned → owner reattaches.
- Same document in two panes → one mutation → both panes and sidebar agree.

---

## Review Focus

Reviewers should verify:
1. **Separation of Concerns**: Whether `TextAnnotation` remains clean of review adjudication semantics (no premature Accept/Reject on annotations).
2. **Transaction Boundaries**: Whether cross-section mutations (proposals addressing annotations) execute atomically under the single per-document mutex.
3. **Anchor Correctness**: Whether boundary insertions, total deletions, and external drift cases strictly follow the mathematical mapping rules.
4. **UI Consolidation**: Whether all review adjudication controls cleanly move to the sidebar without leaving phantom block widgets in the editor.

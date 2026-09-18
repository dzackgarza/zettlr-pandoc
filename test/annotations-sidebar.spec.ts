/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotations panel (M7) tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves the workspace collaboration panel model and store.
 *                  The panel aggregates every workspace document carrying
 *                  open annotations or outstanding review suggestions, groups
 *                  rows by document, and treats each row as navigation into
 *                  the editor rather than reproducing annotation detail or a
 *                  review diff in the sidebar. Review suggestions expose
 *                  Accept all at document and workspace scope.
 *
 *                  Legacy per-document annotation/editor state is still
 *                  exercised where the editor consumes it; workspace tests
 *                  prove the new multi-document snapshot and bulk-action
 *                  fences over the same provider IPC boundary.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// Must be the first local import: it installs window.ipc as a side effect,
// before the store below reads window.ipc at its own module top level.
import { documentCollaborationIpcDouble } from "./document-collaboration-ipc-double";
import { createPinia, setActivePinia } from "pinia";
import { useDocumentCollaborationStore } from "source/pinia/document-collaboration-store";
import { CollaborationApplicationService } from "source/app/service-providers/documents/document-collaboration-application-service";
import { DocumentAuthority as SharedDocumentAuthority } from "./collaboration-test-authority";
import type { TextAnnotation, AnnotationMessage } from "@dts/common/annotation-domain";
import {
  buildAnnotationCards,
  buildSuggestionCards,
  chunkNoteCommit,
  createLineIndex,
  deriveActionRow,
  deriveCardTitle,
  filterCards,
  lineNumberFor,
  openAnnotationCount,
  partitionByResolution,
  suggestionIdsForPacketIds,
  unresolvedCollaborationCount,
} from "source/win-main/sidebar/annotations/annotation-panel-model";
import {
  buildSceneReview,
  buildSceneSession,
  buildSceneSessionWithOrphan,
  buildSceneSessionWithReview,
  SCENE_ANNOTATION_ORPHANED_ID,
  SCENE_ANNOTATION_PROPOSAL_ID,
  SCENE_ANNOTATION_RESOLVED_ID,
  SCENE_ANNOTATION_THREAD_ID,
  SCENE_CHUNK_GOAL_ID,
  SCENE_CHUNK_GOAL_NOTE,
  SCENE_CHUNK_TASKS_ID,
  SCENE_REVIEW_GENERATION,
  SCENE_REVIEW_ID,
  SCENE_WORKING_SHA256,
} from "./annotations-sidebar-scene-fixture";

describe("annotation-panel-model", function () {
  const session = buildSceneSession();
  const { workingText, annotations } = session;
  const cards = buildAnnotationCards(annotations.items, workingText);

  it("derives a card's title from the first sentence of its first message, not a stored field (I8)", function () {
    assert.equal(deriveCardTitle("Do we have examples of tasks that remain resistant? Add sources."), "Do we have examples of tasks that remain resistant?");
    // Two different annotation objects with the SAME first-message text get
    // the SAME title: proof it is computed fresh, not read off an object
    // field that could drift from the message.
    const a = deriveCardTitle("Framing human strengths matters here. More detail follows.");
    const b = deriveCardTitle("Framing human strengths matters here. A different second sentence.");
    assert.equal(a, b);
    assert.equal(a, "Framing human strengths matters here.");
  });

  it("truncates a title with no sentence-ending punctuation instead of running unbounded", function () {
    const long = "a".repeat(200);
    const title = deriveCardTitle(long);
    assert.ok(title.length <= 70, `expected a truncated title, got ${title.length} chars`);
    assert.ok(title.endsWith("…"));
  });

  it("assigns ordinals by document position across open AND resolved annotations together (S4)", function () {
    // Document order: thread (line 3) < proposal (line 7) < resolved (line 11).
    const byId = new Map(cards.map(card => [card.annotation.annotationId, card.ordinal]));
    assert.equal(byId.get(SCENE_ANNOTATION_THREAD_ID), 1);
    assert.equal(byId.get(SCENE_ANNOTATION_PROPOSAL_ID), 2);
    assert.equal(byId.get(SCENE_ANNOTATION_RESOLVED_ID), 3);
  });

  it("counts every unresolved annotation and review suggestion for the activity-bar indicator", function () {
    const annotationOnly = buildSceneSession();
    assert.equal(
      unresolvedCollaborationCount(annotationOnly),
      2,
      "the resolved annotation is not unresolved work",
    );

    const withReview = buildSceneSessionWithReview();
    assert.equal(
      unresolvedCollaborationCount(withReview),
      4,
      "two open annotations plus two outstanding review suggestions are four owner decisions",
    );
  });

  it("reports the source line a target still occupies, and reports orphaned targets as having none", function () {
    const threadCard = cards.find(c => c.annotation.annotationId === SCENE_ANNOTATION_THREAD_ID);
    assert.ok(threadCard !== undefined);
    assert.equal(threadCard.lineLocator, "Ln 3");
    assert.equal(threadCard.lineNumber, 3);

    const orphaned: TextAnnotation = {
      annotationId: "orphan-1",
      documentId: session.documentId,
      anchor: { state: "orphaned", quotedText: "vanished text", reason: "external-drift" },
      state: "open",
      messages: [{ messageId: "m", author: "owner", text: "Where did this go?", createdAt: new Date().toISOString() }],
      proposalActions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(lineNumberFor(orphaned.anchor, workingText), undefined);
    const [orphanedCard] = buildAnnotationCards([orphaned], workingText);
    assert.equal(orphanedCard.lineLocator, "Orphaned");
    assert.equal(orphanedCard.lineNumber, undefined);
  });

  it("partitions resolved cards out of the primary list entirely (S9)", function () {
    const { open, resolved } = partitionByResolution(cards);
    assert.deepEqual(open.map(c => c.annotation.annotationId).sort(), [SCENE_ANNOTATION_PROPOSAL_ID, SCENE_ANNOTATION_THREAD_ID].sort());
    assert.deepEqual(resolved.map(c => c.annotation.annotationId), [SCENE_ANNOTATION_RESOLVED_ID]);
  });

  it("counts open annotations only, not the resolved one sitting alongside them (S10)", function () {
    assert.equal(openAnnotationCount(annotations.items), 2);
    assert.equal(annotations.items.length, 3, "the fixture must actually carry a resolved annotation for this to be a real proof");
  });

  it("derives the terminal action row from annotation state, not a stored menu (S8)", function () {
    const threadRow = deriveActionRow(annotations.items.find(a => a.annotationId === SCENE_ANNOTATION_THREAD_ID)!);
    assert.deepEqual(threadRow, { canReply: true, canShowProposal: false, canReattach: false, resolveLabel: "Resolve" });

    const proposalRow = deriveActionRow(annotations.items.find(a => a.annotationId === SCENE_ANNOTATION_PROPOSAL_ID)!);
    assert.equal(proposalRow.canShowProposal, true, "an annotation with a linked proposal must expose Show proposal");

    const resolvedRow = deriveActionRow(annotations.items.find(a => a.annotationId === SCENE_ANNOTATION_RESOLVED_ID)!);
    assert.equal(resolvedRow.resolveLabel, "Reopen");

    const orphanedRow = deriveActionRow({
      ...annotations.items[0],
      anchor: { state: "orphaned", quotedText: "x", reason: "external-drift" },
    });
    assert.equal(orphanedRow.canReattach, true, "only an orphaned anchor exposes Reattach (S8: never a background guess)");
  });

  it("filters cards by quoted text and by instruction text, case-insensitively", function () {
    const byQuote = filterCards(cards, "meaning-making");
    assert.deepEqual(byQuote.map(c => c.annotation.annotationId), [SCENE_ANNOTATION_THREAD_ID]);

    const byInstruction = filterCards(cards, "PUSH BACK");
    assert.deepEqual(byInstruction.map(c => c.annotation.annotationId), [SCENE_ANNOTATION_PROPOSAL_ID]);

    assert.equal(filterCards(cards, "no such text anywhere").length, 0);
  });

  it("preserves the complete annotation reason instead of truncating it", function () {
    const long = "word ".repeat(60).trim();
    const annotation: TextAnnotation = {
      ...annotations.items[0],
      annotationId: "annotation-long-reason",
      messages: [ { ...annotations.items[0].messages[0], messageId: "message-long-reason", text: long } ]
    };
    const [card] = buildAnnotationCards([annotation], workingText);
    assert.equal(card.instructionText, long);
  });

  it("builds cards from a REAL CollaborationApplicationService's output, not just fixture literals", async function () {
    const documentId = "doc-real-service";
    const documentPath = "/tmp/real-service-note.md";
    const baseline = "Zeroth line.\nThe target sentence sits here.\nThird line.\n";
    const authority = new (class extends SharedDocumentAuthority {
      constructor() { super(baseline, documentId, documentPath); }
    })();
    const service = new CollaborationApplicationService({
      authority,
      sidecarDirectory: mkdtempSync(join(tmpdir(), "zettlr-annotations-panel-model-")),
      emit: () => undefined,
      warn: () => undefined,
    });

    const from = baseline.indexOf("target sentence");
    const to = from + "target sentence".length;
    const created = await service.createAnnotation({
      documentId, actor: "owner", from, to, instruction: "Tighten this.", expectedAnnotationGeneration: 0,
    });
    assert.ok("annotationId" in created, "annotation creation must succeed against a real service");
    const resolved = await service.resolveAnnotation({
      documentId, annotationId: (created as TextAnnotation).annotationId, actor: "owner", expectedAnnotationGeneration: 1,
    });
    assert.ok("state" in resolved && resolved.state === "resolved");

    const realAnnotations = service.getAnnotations(documentId);
    const realCards = buildAnnotationCards(realAnnotations.items, authority.currentDiskText());
    assert.equal(realCards.length, 1);
    assert.equal(realCards[0].title, "Tighten this.");
    assert.equal(realCards[0].lineLocator, "Ln 2");
    assert.equal(openAnnotationCount(realAnnotations.items), 0, "the annotation is resolved, so the open count must be zero");
  });

  it("builds a fast line index that maps positions to 1-based line numbers via binary search", function () {
    const text = "First line.\nSecond line.\nThird line.\n";
    const index = createLineIndex(text);
    assert.equal(index.lineOfPosition(0), 1);
    assert.equal(index.lineOfPosition(5), 1);
    assert.equal(index.lineOfPosition(11), 1);
    assert.equal(index.lineOfPosition(12), 2);
    assert.equal(index.lineOfPosition(24), 2);
    assert.equal(index.lineOfPosition(25), 3);
    assert.equal(index.lineOfPosition(999), 4);
  });
});

describe("useDocumentCollaborationStore panel surface", function () {
  const session = buildSceneSession();

  beforeEach(function () {
    setActivePinia(createPinia());
    documentCollaborationIpcDouble.reset();
  });

  it("precomputes cards in the background upon ensureSession and getCards reads them directly", async function () {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);

    const cards = store.getCards(session.documentPath);
    assert.equal(cards.length, session.annotations.items.length);
    assert.equal(cards[0].ordinal, 1);
    assert.ok(cards[0].lineLocator.startsWith("Ln ") || cards[0].lineLocator === "Orphaned");
  });

  it("precomputes cards in the background upon document-collaboration broadcast", function () {
    const store = useDocumentCollaborationStore();
    documentCollaborationIpcDouble.emit("documents-update", {
      event: "document-collaboration",
      context: {
        filePath: session.documentPath,
        collaborationSession: session,
      },
    });

    const cards = store.getCards(session.documentPath);
    assert.equal(cards.length, session.annotations.items.length);
    assert.equal(store.cardsByDocumentPath[session.documentPath]?.length, session.annotations.items.length);
  });

  it("selectAnnotation controls the editor locator selection without creating sidebar drilldown state", function () {
    const store = useDocumentCollaborationStore();
    store.selectAnnotation(SCENE_ANNOTATION_THREAD_ID);
    assert.equal(store.selectedAnnotationId, SCENE_ANNOTATION_THREAD_ID);
    store.selectAnnotation(null);
    assert.equal(store.selectedAnnotationId, null);
    assert.equal("inspectorMode" in store, false);
  });

  it("toggleShowResolved flips the disclosure, and accepts an explicit value", function () {
    const store = useDocumentCollaborationStore();
    assert.equal(store.showResolved, false);
    store.toggleShowResolved();
    assert.equal(store.showResolved, true);
    store.toggleShowResolved(false);
    assert.equal(store.showResolved, false);
  });

  it("resolveAnnotation sends a fenced IPC request and does not touch the cache itself — only a broadcast does", async function () {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);
    const beforeMutation = store.getSession(session.documentPath);

    let seenCommand: string | undefined;
    let seenPayload: unknown;
    const resolvedAnnotation: TextAnnotation = {
      ...session.annotations.items[0],
      state: "resolved",
      resolvedAt: new Date().toISOString(),
    };
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seenCommand = message.command;
      seenPayload = message.payload;
      return resolvedAnnotation;
    });

    const result = await store.resolveAnnotation(session.documentPath, SCENE_ANNOTATION_THREAD_ID);
    assert.equal(seenCommand, "documents:resolve-annotation");
    // No `actor`: the typed channel's input type declares no such field and
    // its handler hardcodes 'owner', so the renderer has nothing to send.
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_THREAD_ID,
      expectedAnnotationGeneration: session.annotations.generation,
    });
    assert.deepEqual(result, resolvedAnnotation);
    // The mutation call resolved, but sessionsByDocumentPath must be exactly
    // what it was before the call — only a broadcast is allowed to move it.
    assert.deepEqual(store.getSession(session.documentPath), beforeMutation);
  });

  it("addAnnotationMessage sends the owner's text as an owner-authored message request", async function () {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);

    let seenCommand: string | undefined;
    let seenPayload: unknown;
    const postedMessage: AnnotationMessage = { messageId: "reply-1", author: "owner", text: "Please add a source.", createdAt: new Date().toISOString() };
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seenCommand = message.command;
      seenPayload = message.payload;
      return postedMessage;
    });

    const result = await store.addAnnotationMessage(session.documentPath, SCENE_ANNOTATION_PROPOSAL_ID, "Please add a source.");
    assert.equal(seenCommand, "documents:add-annotation-message");
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_PROPOSAL_ID,
      text: "Please add a source.",
      expectedAnnotationGeneration: session.annotations.generation,
    });
    assert.deepEqual(result, postedMessage);
  });

  it("reattachAnnotation carries the owner-selected replacement range, never a guessed one (S8/I6)", async function () {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);

    let seenCommand: string | undefined;
    let seenPayload: unknown;
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seenCommand = message.command;
      seenPayload = message.payload;
      return { ...session.annotations.items[0], anchor: { state: "range", from: 40, to: 52, quotedText: "replacement" } };
    });

    await store.reattachAnnotation(session.documentPath, SCENE_ANNOTATION_THREAD_ID, 40, 52);
    assert.equal(seenCommand, "documents:reattach-annotation");
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_THREAD_ID,
      from: 40,
      to: 52,
      expectedAnnotationGeneration: session.annotations.generation,
    });
  });

  it("reopenAnnotation names its own channel, fenced on the same snapshot resolve is", async function () {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);

    let seenCommand: string | undefined;
    let seenPayload: unknown;
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seenCommand = message.command;
      seenPayload = message.payload;
      return { ...session.annotations.items[0], state: "open" };
    });

    await store.reopenAnnotation(session.documentPath, SCENE_ANNOTATION_THREAD_ID);
    assert.equal(seenCommand, "documents:reopen-annotation");
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_THREAD_ID,
      expectedAnnotationGeneration: session.annotations.generation,
    });
  });
});

describe("suggestion inspector model", function () {
  const review = buildSceneReview();
  const cards = buildSuggestionCards(review);

  it("shows each outstanding chunk with the claim that proposed it", function () {
    assert.deepEqual(cards.map(card => card.suggestionId), [SCENE_CHUNK_TASKS_ID, SCENE_CHUNK_GOAL_ID]);
    assert.deepEqual(cards.map(card => card.description), [
      "Say which tasks automation actually handles.",
      "Frame the goal as collaboration, not replacement.",
    ]);
  });

  it("reads both sides of a chunk out of the same working text its anchors index", function () {
    // The insertion is SLICED from review.workingText, never carried
    // alongside it: a card cannot show a span from a different moment of the
    // document than the offsets that produced it.
    assert.deepEqual(cards.map(card => card.insertedText), ["well-defined tasks", "to work with it"]);
    assert.deepEqual(cards.map(card => card.removedText), ["narrow tasks", "to replace it"]);
  });

  it("locates each chunk on its own source line", function () {
    assert.deepEqual(cards.map(card => card.lineLocator), ["Ln 7", "Ln 11"]);
    assert.deepEqual(cards.map(card => card.lineNumber), [7, 11]);
  });

  it("prefills a chunk's note field from the provider, and only its own chunk's", function () {
    assert.equal(cards[1].comment, SCENE_CHUNK_GOAL_NOTE);
    assert.equal(cards[0].comment, "", "a chunk with no note starts empty rather than borrowing another's");
  });

  it("commits a trimmed note, commits nothing when it did not change, and commits an emptied field as the removal", function () {
    const noted = cards[1];
    assert.equal(chunkNoteCommit(noted, `  ${SCENE_CHUNK_GOAL_NOTE}  `), undefined, "an unchanged note is no mutation");
    assert.equal(chunkNoteCommit(noted, "  rewritten  "), "rewritten");
    assert.equal(chunkNoteCommit(noted, ""), "", "an emptied field removes the note");
    assert.equal(chunkNoteCommit(cards[0], "   "), undefined, "whitespace in an already-empty field is still no mutation");
  });

  it("finds only the chunk(s) a given set of packets produced (S7: Show proposal)", function () {
    // buildSceneReview links SCENE_CHUNK_GOAL_ID to packet-1 alone
    // (annotations-sidebar-scene-fixture.ts) — the packet
    // SCENE_ANNOTATION_PROPOSAL_ID's proposalActions name.
    assert.deepEqual(suggestionIdsForPacketIds(review, ["packet-1"]), [SCENE_CHUNK_GOAL_ID]);
    assert.deepEqual(
      suggestionIdsForPacketIds(review, ["packet-nobody-linked"]),
      [],
      "a packet with no outstanding chunk must find nothing, not throw or fabricate one",
    );
  });
});

describe("useDocumentCollaborationStore review surface", function () {
  const session = buildSceneSessionWithReview();

  beforeEach(function () {
    setActivePinia(createPinia());
    documentCollaborationIpcDouble.reset();
  });

  /** A store hydrated with the reviewed session, ready to adjudicate. */
  async function hydratedStore (): Promise<ReturnType<typeof useDocumentCollaborationStore>> {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);
    return store;
  }

  /** Records the next invoke and answers it with the provider's own shape. */
  function captureNextRequest (response: unknown): { seen: { command?: string, payload?: unknown } } {
    const seen: { command?: string, payload?: unknown } = {};
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seen.command = message.command;
      seen.payload = message.payload;
      return response;
    });
    return { seen };
  }

  const fence = {
    reviewId: SCENE_REVIEW_ID,
    expectedReviewGeneration: SCENE_REVIEW_GENERATION,
    expectedWorkingSha256: SCENE_WORKING_SHA256,
  };

  it("sends a chunk decision on its own typed channel, addressing the chunk and fencing on the snapshot it was formed against", async function () {
    const store = await hydratedStore();
    const before = store.getSession(session.documentPath);
    const { seen } = captureNextRequest({ ok: true, chunkId: SCENE_CHUNK_TASKS_ID });

    const result = await store.decideReviewChunk(session.documentPath, SCENE_CHUNK_TASKS_ID, "accept");

    assert.equal(seen.command, "documents:decide-review-chunk");
    assert.deepEqual(seen.payload, { ...fence, chunkId: SCENE_CHUNK_TASKS_ID, decision: "accept" });
    assert.deepEqual(result, { ok: true, chunkId: SCENE_CHUNK_TASKS_ID });
    // A decision decides nothing locally: only the broadcast moves the cache.
    assert.deepEqual(store.getSession(session.documentPath), before);
  });

  it("addresses the second chunk when the second chunk is decided, not the first", async function () {
    const store = await hydratedStore();
    const { seen } = captureNextRequest({ ok: true });

    await store.decideReviewChunk(session.documentPath, SCENE_CHUNK_GOAL_ID, "reject");

    assert.deepEqual(seen.payload, { ...fence, chunkId: SCENE_CHUNK_GOAL_ID, decision: "reject" });
  });

  it("sends a chunk note under the same fence a decision uses, since the chunk id is content-addressed", async function () {
    const store = await hydratedStore();
    const { seen } = captureNextRequest({ ok: true });

    await store.commentReviewChunk(session.documentPath, SCENE_CHUNK_GOAL_ID, "rewritten");

    assert.equal(seen.command, "documents:comment-review-chunk");
    assert.deepEqual(seen.payload, { ...fence, chunkId: SCENE_CHUNK_GOAL_ID, text: "rewritten" });
  });

  it("sends the two mass actions under the fence one decision uses, and changes nothing locally", async function () {
    const store = await hydratedStore();
    const before = store.getSession(session.documentPath);

    const acceptAll = captureNextRequest({ ok: true, acceptedChunks: 2 });
    await store.acceptAllReviewChunks(session.documentPath);
    assert.equal(acceptAll.seen.command, "documents:accept-all-review-chunks");
    assert.deepEqual(acceptAll.seen.payload, fence);

    const clear = captureNextRequest({ ok: true });
    await store.clearReview(session.documentPath);
    assert.equal(clear.seen.command, "documents:clear-review");
    assert.deepEqual(clear.seen.payload, fence);

    assert.deepEqual(store.getSession(session.documentPath), before);
  });

  it("fences a review-level comment on the generation alone: it adjudicates nothing and moves no text", async function () {
    const store = await hydratedStore();
    const { seen } = captureNextRequest({ ok: true });

    await store.addReviewComment(session.documentPath, "overall note");

    assert.equal(seen.command, "documents:add-review-comment");
    assert.deepEqual(seen.payload, {
      reviewId: SCENE_REVIEW_ID,
      text: "overall note",
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
    });
  });

  it("hands a provider refusal back as a value the panel can surface, without touching the cache", async function () {
    const store = await hydratedStore();
    const before = store.getSession(session.documentPath);
    captureNextRequest({
      ok: false,
      code: "REVIEW_GENERATION_MISMATCH",
      message: "The review is at generation 5, not 4.",
      reviewGeneration: 5,
    });

    const result = await store.decideReviewChunk(session.documentPath, SCENE_CHUNK_TASKS_ID, "accept");

    assert.equal(result.ok, false);
    assert.deepEqual(store.getSession(session.documentPath), before);
  });

  it("fences against the snapshot on screen now, not the one the panel first rendered", async function () {
    // Every review mutation broadcasts a new session, and a chunk nobody
    // touched keeps its card. A decision bound to the generation the card was
    // BUILT with would name a review state nobody is looking at any more, and
    // the provider would refuse a decision that is in fact current.
    const store = await hydratedStore();
    documentCollaborationIpcDouble.emit("documents-update", {
      event: "document-collaboration",
      context: {
        filePath: session.documentPath,
        collaborationSession: {
          ...session,
          workingSha256: "b".repeat(64),
          review: { ...session.review!, reviewGeneration: SCENE_REVIEW_GENERATION + 3 },
        },
      },
    });

    const { seen } = captureNextRequest({ ok: true });
    await store.decideReviewChunk(session.documentPath, SCENE_CHUNK_TASKS_ID, "accept");

    assert.deepEqual(seen.payload, {
      reviewId: SCENE_REVIEW_ID,
      chunkId: SCENE_CHUNK_TASKS_ID,
      decision: "accept",
      expectedReviewGeneration: SCENE_REVIEW_GENERATION + 3,
      expectedWorkingSha256: "b".repeat(64),
    });
  });

  it("refuses to fabricate a fence for a document carrying no review", async function () {
    const annotationsOnly = buildSceneSession();
    documentCollaborationIpcDouble.setInvokeResponder(async () => annotationsOnly);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(annotationsOnly.documentPath);

    await assert.rejects(async () => await store.acceptAllReviewChunks(annotationsOnly.documentPath));
    assert.equal(
      documentCollaborationIpcDouble.invokeCallCount("documents:accept-all-review-chunks"),
      0,
      "a mutation with no review to name never reaches the provider",
    );
  });

  it("hydrates collaboration state for multiple workspace documents at once", async function () {
    const second = {
      ...session,
      documentId: "doc-second",
      documentPath: "/tmp/second-workspace-note.md",
      workingSha256: "c".repeat(64),
      review: {
        ...session.review!,
        id: "review-second",
        documentPath: "/tmp/second-workspace-note.md",
        reviewGeneration: 9,
      },
    };
    documentCollaborationIpcDouble.setInvokeResponder(async (message) =>
      message.command === "get-workspace-collaboration-sessions" ? [session, second] : undefined
    );
    const store = useDocumentCollaborationStore();

    await store.refreshWorkspaceSessions([session.documentPath, second.documentPath]);

    assert.deepEqual(store.workspaceSessions.map(item => item.documentPath).sort(),
      [session.documentPath, second.documentPath].sort());
    assert.equal(
      store.workspaceUnresolvedCount,
      unresolvedCollaborationCount(session) + unresolvedCollaborationCount(second),
    );
  });

  it("accepts all outstanding review chunks for one workspace document through the workspace channel", async function () {
    const seen: Array<{ command: string, payload: unknown }> = [];
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seen.push({ command: message.command, payload: message.payload });
      if (message.command === "get-workspace-collaboration-sessions") {
        return [session];
      }
      if (message.command === "documents:accept-all-workspace-review-chunks") {
        return { ok: true, acceptedChunks: 2 };
      }
      return undefined;
    });
    const store = useDocumentCollaborationStore();
    await store.refreshWorkspaceSessions([session.documentPath]);

    await store.acceptAllWorkspaceReviewChunks(session.documentPath);

    const request = seen.find(item => item.command === "documents:accept-all-workspace-review-chunks");
    assert.deepEqual(request?.payload, { path: session.documentPath, ...fence });
    assert.equal(documentCollaborationIpcDouble.invokeCallCount("get-workspace-collaboration-sessions"), 2);
  });

  it("global Accept all sends one fenced workspace acceptance per reviewed document", async function () {
    const secondPath = "/tmp/second-workspace-note.md";
    const second = {
      ...session,
      documentId: "doc-second",
      documentPath: secondPath,
      workingSha256: "d".repeat(64),
      review: { ...session.review!, id: "review-second", documentPath: secondPath, reviewGeneration: 9 },
    };
    const accepted: string[] = [];
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      if (message.command === "get-workspace-collaboration-sessions") {
        return [session, second];
      }
      if (message.command === "documents:accept-all-workspace-review-chunks") {
        accepted.push((message.payload as { path: string }).path);
        return { ok: true, acceptedChunks: 2 };
      }
      return undefined;
    });
    const store = useDocumentCollaborationStore();
    await store.refreshWorkspaceSessions([session.documentPath, secondPath]);

    const results = await store.acceptAllWorkspaceReviews();

    assert.deepEqual(accepted.sort(), [session.documentPath, secondPath].sort());
    assert.equal(results.length, 2);
  });
});

describe("workspace annotations panel structure", function () {
  it("groups by document, exposes both Accept-all scopes, navigates rows, and renders no sidebar diff", function () {
    const panel = readFileSync("source/win-main/sidebar/AnnotationsTab.vue", "utf8");
    const header = readFileSync("source/win-main/sidebar/annotations/AnnotationHeader.vue", "utf8");
    const app = readFileSync("source/win-main/App.vue", "utf8");

    assert.match(panel, /annotation-document-group/);
    assert.match(panel, /annotation-document-accept-all/);
    assert.match(header, /annotation-global-accept-all/);
    assert.match(panel, /emit\('navigate'/);
    assert.doesNotMatch(panel, /SuggestionInspector|AnnotationInspector/);
    assert.doesNotMatch(panel, /suggestion-removed|suggestion-inserted/);
    assert.doesNotMatch(panel, /annotation-line-locator/);
    assert.doesNotMatch(panel, /annotation-workspace-kind/);
    assert.doesNotMatch(panel, /trans\('Change'\)|trans\('Annotation'\)/);
    const summaryStyle = panel.match(/\.annotation-workspace-summary\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    assert.doesNotMatch(summaryStyle, /text-overflow:\s*ellipsis/);
    assert.doesNotMatch(summaryStyle, /white-space:\s*nowrap/);
    assert.match(summaryStyle, /white-space:\s*normal/);
    assert.match(app, /workspaceUnresolvedCount/);
    assert.match(app, /targetRange: target\.range/);
  });
});

describe("workspace annotation fixtures", function () {
  it("buildSceneSessionWithOrphan carries a fourth, orphaned, OPEN annotation alongside the base three", function () {
    const fixture = buildSceneSessionWithOrphan();
    assert.equal(fixture.annotations.items.length, 4);
    const orphaned = fixture.annotations.items.find(a => a.annotationId === SCENE_ANNOTATION_ORPHANED_ID);
    assert.ok(orphaned !== undefined);
    assert.equal(orphaned.anchor.state, "orphaned");
    assert.equal(orphaned.state, "open");
  });
});

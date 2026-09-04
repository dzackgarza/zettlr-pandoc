/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotations panel (M7) tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Two halves.
 *
 *                  The first half is the panel's pure view model
 *                  (annotation-panel-model.ts): title derivation (I8), the
 *                  ordinal sequence shared by open and resolved cards (S4),
 *                  the open/resolved partition (S9), the open-only count
 *                  (S10), and the terminal action row (S8). One case runs
 *                  the model against a REAL CollaborationApplicationService's
 *                  output rather than fixture literals, so it cannot pass
 *                  on a model that merely echoes a hand-built TextAnnotation
 *                  shape.
 *
 *                  The second half is the renderer store's panel-only
 *                  surface (selection, the resolved toggle, and the four
 *                  owner mutation calls), exercised against the real
 *                  preload-bridge double (document-collaboration-ipc-double.ts,
 *                  the same one M4's own spec uses). It proves the calls are
 *                  well-formed IPC requests — command name, generation
 *                  fence, payload shape — and that none of them mutates
 *                  sessionsByDocumentPath itself: the cache only ever moves
 *                  through the DP_EVENTS.DOCUMENT_COLLABORATION broadcast.
 *
 *                  The third half proves the tab badge is the OPEN count, on
 *                  screen, from a REAL mounted MainSidebar.vue — not just
 *                  from openAnnotationCount() in isolation, which cannot
 *                  catch MainSidebar.vue's own wiring passing the wrong
 *                  number or no number at all.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
// Must be the first local import: it installs window.ipc as a side effect,
// before the store below reads window.ipc at its own module top level.
import { documentCollaborationIpcDouble } from "./document-collaboration-ipc-double";
import { createPinia, setActivePinia } from "pinia";
import { useDocumentCollaborationStore } from "source/pinia";
import { CollaborationApplicationService } from "source/app/service-providers/documents/document-collaboration-application-service";
import { DocumentAuthority as SharedDocumentAuthority } from "./collaboration-test-authority";
import type { TextAnnotation, AnnotationMessage } from "@dts/common/annotation-domain";
import {
  buildAnnotationCards,
  deriveActionRow,
  deriveCardTitle,
  filterCards,
  formatLineLocator,
  lineNumberFor,
  openAnnotationCount,
  partitionByResolution,
  truncatePreview,
} from "source/win-main/sidebar/annotations/annotation-panel-model";
import { buildSceneSession, SCENE_ANNOTATION_PROPOSAL_ID, SCENE_ANNOTATION_RESOLVED_ID, SCENE_ANNOTATION_THREAD_ID } from "./annotations-sidebar-scene-fixture";

const execFileAsync = promisify(execFile);

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
    assert.equal(formatLineLocator(orphaned.anchor, workingText), "Orphaned");
    assert.equal(lineNumberFor(orphaned.anchor, workingText), undefined);
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

  it("truncates a long instruction preview instead of rendering it unbounded", function () {
    const long = "word ".repeat(60);
    const preview = truncatePreview(long, 40);
    assert.ok(preview.length <= 40);
    assert.ok(preview.endsWith("…"));
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
});

describe("useDocumentCollaborationStore panel surface", function () {
  const session = buildSceneSession();

  beforeEach(function () {
    setActivePinia(createPinia());
    documentCollaborationIpcDouble.reset();
  });

  it("selectAnnotation switches the inspector mode, and clearing the selection returns to the list", function () {
    const store = useDocumentCollaborationStore();
    assert.equal(store.inspectorMode, "list");
    store.selectAnnotation(SCENE_ANNOTATION_THREAD_ID);
    assert.equal(store.selectedAnnotationId, SCENE_ANNOTATION_THREAD_ID);
    assert.equal(store.inspectorMode, "detail");
    store.selectAnnotation(null);
    assert.equal(store.selectedAnnotationId, null);
    assert.equal(store.inspectorMode, "list");
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
    assert.equal(seenCommand, "resolve-annotation");
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_THREAD_ID,
      actor: "owner",
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

    let seenPayload: unknown;
    const postedMessage: AnnotationMessage = { messageId: "reply-1", author: "owner", text: "Please add a source.", createdAt: new Date().toISOString() };
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seenPayload = message.payload;
      return postedMessage;
    });

    const result = await store.addAnnotationMessage(session.documentPath, SCENE_ANNOTATION_PROPOSAL_ID, "Please add a source.");
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_PROPOSAL_ID,
      actor: "owner",
      text: "Please add a source.",
      expectedAnnotationGeneration: session.annotations.generation,
    });
    assert.deepEqual(result, postedMessage);
  });

  it("reattachAnnotation carries the owner-selected replacement range, never a guessed one (S8/I6)", async function () {
    documentCollaborationIpcDouble.setInvokeResponder(async () => session);
    const store = useDocumentCollaborationStore();
    await store.ensureSession(session.documentPath);

    let seenPayload: unknown;
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      seenPayload = message.payload;
      return { ...session.annotations.items[0], anchor: { state: "range", from: 40, to: 52, quotedText: "replacement" } };
    });

    await store.reattachAnnotation(session.documentPath, SCENE_ANNOTATION_THREAD_ID, 40, 52);
    assert.deepEqual(seenPayload, {
      path: session.documentPath,
      annotationId: SCENE_ANNOTATION_THREAD_ID,
      actor: "owner",
      from: 40,
      to: 52,
      expectedAnnotationGeneration: session.annotations.generation,
    });
  });
});

describe("MainSidebar annotations tab badge (S10 boundary proof)", function () {
  // Counting open-only (openAnnotationCount) is proved as a pure function
  // above. That does not prove the badge on screen shows it: the wiring
  // that reads the store and hands TabBar.vue a number lives in
  // MainSidebar.vue's own script, where a mistake (passing the total
  // instead, or omitting the prop) would leave that pure-function test
  // green while the tab itself lied.
  //
  // vue-tsc/tsx cannot import a .vue SFC directly (confirmed: attempting it
  // here throws "Unexpected token '<'" on MainSidebar.vue's <template>), so
  // this cannot mount MainSidebar in-process the way the store tests above
  // exercise the Pinia store directly. It instead follows this repository's
  // established pattern for proving real Vue rendering from a plain mocha
  // spec (test/reference-search-overlay.spec.ts): build the real webpack
  // renderer bundle, mount BOTH AnnotationsTab.vue (for the four capture
  // scenes) and a real, separately mounted MainSidebar.vue sharing the same
  // Pinia session in isolated offscreen Electron, and read the rendered
  // badge text out of that mount's DOM — the same bundle and driver `just
  // capture-annotations-panel` uses, with one JSON line appended as the
  // proof this spec asserts on.
  it("renders the annotations tab badge as the OPEN count, not the total, for a mounted session carrying both", async function () {
    this.timeout(240000);
    const outputDirectory = mkdtempSync(join(tmpdir(), "zettlr-annotations-badge-"));
    const root = process.cwd();
    await execFileAsync("node", [join(root, "test/annotations-sidebar-visual-build.cjs"), outputDirectory], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const { stdout } = await execFileAsync(
      "xvfb-run",
      [
        "-a",
        join(root, "node_modules/.bin/electron"),
        "--ozone-platform=x11",
        "--disable-gpu",
        "--no-sandbox",
        join(root, "test/annotations-sidebar-visual-capture.cjs"),
        outputDirectory,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const jsonLine = stdout.trim().split("\n").at(-1);
    assert.ok(jsonLine !== undefined, "the capture driver must print the badge probe result");
    const result = JSON.parse(jsonLine as string) as { mainSidebarAnnotationsBadge: string | null };

    // The fixture session (annotations-sidebar-scene-fixture.ts) carries
    // exactly 2 open and 1 resolved annotation — 3 total, so a badge
    // reading "3" would mean MainSidebar passed the total, and no badge at
    // all would mean the prop was never wired.
    assert.equal(
      result.mainSidebarAnnotationsBadge,
      "2",
      `the rendered badge must read the OPEN count (2), not the total (3) or nothing: got ${JSON.stringify(result.mainSidebarAnnotationsBadge)}`,
    );
  });
});

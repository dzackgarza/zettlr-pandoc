// Captures the collaboration scenes of the plan's capture suite (section 10:
// 03/05/10/11, then M10's 04/06/12) plus the review controls, in the current
// design: the workspace list in the right-hand panel, and the chunk
// controls, the review bar and the annotation thread inside the editor
// pane. Loads the webpack bundle produced by visual-build.cjs once, then
// drives the real Pinia store and the real components through the window
// functions the entry exposes between screenshots.
//
// Usage: node test/annotations-sidebar-visual-capture.mjs <outputDirectory>

import { strict as assert } from "node:assert";
import { openScene } from "./visual/scene.mjs";

const SCENE_DOCUMENT_PATH = "/tmp/annotations-scene-note.md";
const SCENE_THREAD_ID = "annotation-thread";
const SCENE_PROPOSAL_ID = "annotation-proposal";
const SCENE_RESOLVED_ID = "annotation-resolved";
const SCENE_ORPHANED_ID = "annotation-orphaned";
const SCENE_MULTITURN_ID = "annotation-multiturn";
const SCENE_PARTIAL_ID = "annotation-partial-proposal";
const SCENE_CHUNK_TASKS_ID = "suggestion-tasks";
const SCENE_REVIEW_ID = "review-scene";
const SCENE_REVIEW_GENERATION = 4;
const SCENE_WORKING_SHA256 = "a".repeat(64);
const SCENE_CHUNK_GOAL_NOTE = "Check this against the published erratum first.";
// The goal chunk's working span ("to work with it"), which the proposal
// annotation's linked packet produced (annotations-sidebar-scene-fixture.ts).
const SCENE_GOAL_TEXT = "to work with it";
// The file of collaboration state that the provider cannot read
// (annotations-sidebar-visual-entry.ts).
const SCENE_UNREADABLE_FILE = `/home/author/.config/Zettlr-Pandoc/review-sidecars/${"82c4c2e2483dfc75".repeat(4)}.json`;

const WIDE = { width: 980, height: 760, panel: 340 };
const NARROW = { width: 620, height: 760, panel: 240 };
const DARK_COMPLETE = { width: 1400, height: 760, panel: 340 };

// The fixture's messages are minutes after its BASE_TIME
// (annotations-sidebar-scene-fixture.ts), the latest thirty minutes after
// it; the page's clock starts one minute past that, so every message is in
// the past and the thread's first message reads "31 min. ago".
const SCENE_NOW = Date.parse("2026-05-20T10:31:00.000Z");

const scene = await openScene({
  width: WIDE.width,
  height: WIDE.height,
  args: ["--ozone-platform=x11", "--disable-gpu"],
});
const { page } = scene;
await page.clock.install({ time: SCENE_NOW });

async function openSceneDocument(dark) {
  const background = dark ? "#1e1e1e" : "#ffffff";
  const foreground = dark ? "#e5e7eb" : "#222222";
  const border = dark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.12)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; background: ${background}; color: ${foreground}; }
    body { font-family: sans-serif; box-sizing: border-box; --scene-panel-width: ${WIDE.panel}px; }
    #scene-layout { display: flex; height: 100%; }
    /* Scene 12 only: hidden (and out of layout) for every other scene. */
    #editor-complete { display: none; width: 440px; height: 100%; flex-shrink: 0; overflow: auto; border-right: 1px solid ${border}; }
    #editor { flex: 1 1 auto; min-width: 0; height: 100%; overflow: auto; }
    #editor .cm-editor { min-height: 100%; }
    #app { width: var(--scene-panel-width); flex-shrink: 0; height: 100%; border-left: 1px solid ${border}; }
  </style></head><body class="${dark ? "dark" : ""}">
    <div id="scene-layout">
      <div id="editor-complete"></div>
      <div id="editor"></div>
      <div id="app"></div>
    </div>
    <script src="./annotations-sidebar-visual-bundle.js"></script>
  </body></html>`;
  // documentTreeStore (constructed by the panel) reads window_id from the
  // page URL to request its leaf.
  await scene.open("annotations-sidebar-scene.html", html, { window_id: "scene-window" });
  await page.evaluate(() => window.captureReady);
}

async function setLayout({ width, height, panel }) {
  await page.evaluate((value) => {
    document.body.style.setProperty("--scene-panel-width", `${value}px`);
  }, panel);
  await scene.setSize(width, height);
}

const diagnostics = async () => await page.evaluate(() => window.annotationsSceneDiagnostics());
const select = async (id) => {
  await page.evaluate((id) => window.annotationsSceneSelect(id), id);
};
const setShowResolved = async (value) => {
  await page.evaluate((value) => window.annotationsSceneSetShowResolved(value), value);
};
const setReview = async (active) => {
  await page.evaluate((active) => window.annotationsSceneSetReview(active), active);
};
const acceptChunk = async (index) =>
  await page.evaluate((index) => window.annotationsSceneAcceptChunk(index), index);

/**
 * Horizontal overflow of every element a scene must keep inside its box,
 * with the descendants that reach past the right edge of that box.
 */
async function overflowing(selectors) {
  return page.evaluate(
    (list) =>
      list.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => {
            const edge = element.getBoundingClientRect().left + element.clientWidth;
            return {
              selector,
              scroll: element.scrollWidth,
              client: element.clientWidth,
              past: [...element.querySelectorAll("*")]
                .filter((child) => child.getBoundingClientRect().right > edge + 1)
                .map(
                  (child) =>
                    `${child.tagName.toLowerCase()}.${[...child.classList].join(".")} +${Math.round(child.getBoundingClientRect().right - edge)}`,
                ),
            };
          }),
      ),
    selectors,
  );
}

await openSceneDocument(false);

const activityBadge = await page.evaluate(() => window.annotationsSceneActivityBadgeDiagnostics());
assert.deepStrictEqual(
  activityBadge,
  {
    text: "4",
    ariaLabel: "Annotations, 4 unresolved",
    unresolvedCount: "4",
  },
  "the right activity-bar icon must visibly and accessibly report unresolved collaboration work",
);

// Scene 03: a thread opened from its gutter chip, inline under its target,
// with the workspace list beside the editor.
let diag = await diagnostics();
assert.deepStrictEqual(diag.threadIds, [], "03: no thread is open before the owner opens one");
await page.evaluate(() => window.annotationsSceneClickChip(3));
diag = await diagnostics();
assert.deepStrictEqual(
  diag.threadIds,
  [SCENE_THREAD_ID],
  "03: the chip on line 3 opens that annotation's thread in the editor",
);
assert.equal(diag.annotationRowCount, 2, "03: the panel lists the two open annotations");
assert.equal(diag.headingCount, 0, "03: the panel header is a body-size row, not a heading");
assert.notEqual(diag.shortcutChip, "", "03: the header carries the panel toggle's shortcut chip");
assert.equal(
  diag.composerPresent,
  true,
  "03: the composer is mounted with the thread, not behind a Reply click",
);
assert.equal(diag.resolveCount, 1, "03: Resolve renders exactly once");
assert.equal(diag.threadLifecycle, "Open");
assert.deepStrictEqual(
  diag.messageTimes,
  ["31 min. ago", "29 min. ago"],
  "03: relative times against the page clock",
);
assert.deepStrictEqual(
  diag.messageTexts,
  [
    "Do we have examples of tasks that remain resistant? Add sources.",
    "Yes. Tasks requiring contextual judgment, ethical reasoning, and novel problem framing remain hard to automate.",
  ],
  "03: the thread shows the text of its messages",
);
assert.deepStrictEqual(
  diag.annotationRowSummaries,
  [
    "Do we have examples of tasks that remain resistant? Add sources.",
    "Automation is not the whole story — push back on this framing.",
  ],
  "03: each panel row shows the instruction of its annotation",
);
await scene.capture("03-selected-thread-light");

// The clock moves two minutes: every relative time moves with it, with no
// reload and no store change.
await page.clock.runFor(2 * 60_000);
diag = await diagnostics();
assert.deepStrictEqual(
  diag.messageTimes,
  ["33 min. ago", "31 min. ago"],
  "relative times must follow the clock",
);

// Mod-Enter in the thread's composer sends the trimmed draft to the
// provider as the owner's message on that annotation; Escape discards a
// draft.
const reply = await page.evaluate(() =>
  window.annotationsSceneComposeReply("  Please cite the erratum.  "),
);
assert.equal(
  reply?.channel,
  "documents:add-annotation-message",
  "the composer must raise the owner message request",
);
assert.equal(reply.message.annotationId, SCENE_THREAD_ID);
assert.equal(reply.message.text, "Please cite the erratum.");
assert.equal(
  await page.evaluate(() => window.annotationsSceneComposeEscape("a draft to discard")),
  "",
  "Escape must clear the composer",
);

// The chip toggles: a second press closes the thread it opened.
await page.evaluate(() => window.annotationsSceneClickChip(3));
diag = await diagnostics();
assert.deepStrictEqual(diag.threadIds, [], "a second press on the chip closes its thread");

// The header's close hands the panel's parent the intent to hide the pane.
assert.equal(
  await page.evaluate(() => window.annotationsSceneClickClose()),
  1,
  "close must reach the parent once",
);

// Scene 05: a thread opened from its row in the workspace panel, one that
// carries a pending linked proposal — the proposal card and its "Show diff".
const navigations = await page.evaluate(
  (id) => window.annotationsSceneClickRow(id),
  SCENE_PROPOSAL_ID,
);
assert.equal(navigations.length, 1);
assert.equal(navigations[0].documentPath, SCENE_DOCUMENT_PATH);
assert.equal(
  navigations[0].annotationId,
  SCENE_PROPOSAL_ID,
  "an annotation row names its annotation",
);
diag = await diagnostics();
assert.deepStrictEqual(
  diag.threadIds,
  [SCENE_PROPOSAL_ID],
  "05: the row opens that annotation's thread in the editor",
);
assert.equal(
  diag.threadLifecycle,
  "Acted",
  "05: agent work state is distinct from owner resolution",
);
assert.equal(
  diag.actedDispositionCount,
  1,
  "05: the acted state points at exactly one agent disposition in the thread",
);
assert.equal(diag.showProposalLabel, "Show diff", "05: the proposal card's one affordance");
await scene.capture("05-linked-proposal-pending");

// Scene 10: resolved annotations shown. The panel lists outstanding work
// only; a resolved annotation is read where it was made — its highlight in
// the editor, and its thread there, marked Resolved and offering Reopen.
await setShowResolved(true);
await select(SCENE_RESOLVED_ID);
diag = await diagnostics();
assert.deepStrictEqual(
  diag.threadIds,
  [SCENE_RESOLVED_ID],
  "10: the resolved annotation's thread opens once resolved ones are shown",
);
assert.equal(diag.threadLifecycle, "Resolved");
assert.equal(diag.resolveLabel, "Reopen", "10: a resolved thread offers Reopen in Resolve's place");
assert.equal(
  diag.annotationRowCount,
  2,
  "10: the panel still lists only the outstanding annotations",
);
assert.equal(
  await page.locator("#editor .cm-textAnnotation-mark-resolved").count(),
  1,
  "10: the resolved target is highlighted in the editor",
);
await scene.capture("10-resolved-annotations-view");

// Scene 11: a narrow window. Nothing drills down any more: the panel's rows
// wrap their whole reason, and the thread wraps inside the narrowed editor.
// Neither may scroll sideways.
await setShowResolved(false);
await select(SCENE_THREAD_ID);
await setLayout(NARROW);
diag = await diagnostics();
assert.deepStrictEqual(diag.threadIds, [SCENE_THREAD_ID]);
assert.deepStrictEqual(
  await overflowing([
    "#annotations-panel",
    ".annotation-workspace-row",
    "#editor .cm-content",
    ".annotation-inline-thread",
  ]),
  [],
  "11: nothing in the narrow layout scrolls sideways",
);
await scene.capture("11-narrow-sidebar-drilldown");

// Scene 04 (04-ai-reply-no-proposal): a genuinely multi-turn thread —
// owner, agent, owner, agent — carrying NO linked proposal, so the proposal
// card must not mount in it.
await setLayout(WIDE);
await page.evaluate(() => window.annotationsSceneSetM10CapturesScenario(true));
await select(SCENE_MULTITURN_ID);
diag = await diagnostics();
assert.deepStrictEqual(diag.threadIds, [SCENE_MULTITURN_ID]);
assert.equal(diag.messageTimes.length, 4, "04: all four turns render");
assert.equal(
  diag.proposalCardText,
  null,
  "04: a thread with no linked proposal renders no proposal card",
);
await scene.capture("04-ai-reply-no-proposal");

// Scene 06 (06-linked-proposal-partial): two linked proposals, one decided
// and one pending — the proposal card names the outcome and the pending
// count — with the
// review's remaining chunks in the same editor, each carrying its controls,
// and the review bar below.
await select(SCENE_PARTIAL_ID);
diag = await diagnostics();
assert.deepStrictEqual(diag.threadIds, [SCENE_PARTIAL_ID]);
assert.ok(
  diag.proposalCardText?.includes("1 accepted. 1 of 2 pending."),
  `06: expected the decided outcome and the pending count, got ${JSON.stringify(diag.proposalCardText)}`,
);
assert.equal(diag.chunkControlCount, 2, "06: both remaining chunks carry their controls");
assert.equal(diag.reviewBarLabel, "2 changes pending");
await scene.capture("06-linked-proposal-partial");

// Scene 06b (06b-linked-proposal-decided): the agent withdrew the pending
// proposal of scene 06, so each proposal of the thread has an outcome and
// the card names each one.
await page.evaluate(() => window.annotationsSceneSetProposalsDecided());
await select(SCENE_PARTIAL_ID);
diag = await diagnostics();
assert.equal(diag.proposalCountText, "Done");
assert.ok(
  diag.proposalCardText?.includes("1 accepted, 1 withdrawn by the agent."),
  `06b: expected each outcome, got ${JSON.stringify(diag.proposalCardText)}`,
);
assert.ok(!diag.proposalCardText?.includes("pending"), "06b: no proposal is pending");
assert.ok(!diag.proposalCardText?.includes("Show diff"), "06b: no change is left to show");
await scene.capture("06b-linked-proposal-decided");
await page.evaluate(() => window.annotationsSceneSetM10CapturesScenario(true));

await page.evaluate(() => window.annotationsSceneSetM10CapturesScenario(false));

// The review controls: under each chunk in the editor, Accept, Reject and
// the note; in the review bar, the pending count, the review comment,
// Reject all and Accept all; in the panel, the document's rows and its
// Accept all. A click raises the fenced provider request rather than
// deciding locally.
await select(null);
await setReview(true);
diag = await diagnostics();
assert.equal(diag.chunkControlCount, 2, "review: the editor carries one control block per chunk");
assert.equal(diag.acceptCount, 2, "review: one Accept per chunk");
assert.equal(diag.rejectCount, 2, "review: one Reject per chunk");
assert.deepStrictEqual(
  diag.chunkNoteValues,
  ["", SCENE_CHUNK_GOAL_NOTE],
  "review: each note field is prefilled from the provider, its own chunk's only",
);
assert.equal(diag.reviewBarPresent, true);
assert.equal(diag.reviewBarMassActionCount, 2, "review: the bar offers Reject all and Accept all");
assert.equal(diag.reviewCommentPresent, true);
assert.equal(diag.suggestionRowCount, 2, "review: the panel lists both outstanding changes");
assert.equal(diag.documentAcceptAllCount, 1, "review: the document group offers its Accept all");
assert.equal(
  diag.globalAcceptAllPresent,
  true,
  "review: the panel header offers the workspace Accept all",
);
await scene.capture("review-inline-controls-light");

assert.deepStrictEqual(
  await acceptChunk(0),
  {
    channel: "documents:decide-review-chunk",
    message: {
      reviewId: SCENE_REVIEW_ID,
      chunkId: SCENE_CHUNK_TASKS_ID,
      decision: "accept",
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
      expectedWorkingSha256: SCENE_WORKING_SHA256,
    },
  },
  "review: Accept raised the wrong request",
);
// Nothing was decided locally: only the provider's broadcast may.
diag = await diagnostics();
assert.equal(diag.chunkControlCount, 2, "review: the pane applied a decision itself");
assert.equal(diag.reviewBarLabel, "2 changes pending");

// A chunk note commits on blur, trimmed, addressing its own chunk.
assert.deepStrictEqual(
  await page.evaluate(() => window.annotationsSceneWriteChunkNote(0, "  check the constant  ")),
  {
    channel: "documents:comment-review-chunk",
    message: {
      reviewId: SCENE_REVIEW_ID,
      chunkId: SCENE_CHUNK_TASKS_ID,
      text: "check the constant",
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
      expectedWorkingSha256: SCENE_WORKING_SHA256,
    },
  },
);

// A review-level comment commits trimmed, and fences on the generation
// alone: it adjudicates nothing and moves no text.
assert.deepStrictEqual(
  await page.evaluate(() => window.annotationsSceneWriteReviewComment("  overall note  ")),
  {
    channel: "documents:add-review-comment",
    message: {
      reviewId: SCENE_REVIEW_ID,
      text: "overall note",
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
    },
  },
);

// Every commit is a review mutation, and its broadcast re-renders the
// controls. A reviewer still typing in a note field must keep the
// characters they have not sent, and the caret with them.
assert.deepStrictEqual(
  await page.evaluate(() => window.annotationsSceneTypeThroughEcho(0, "first second")),
  { value: "first second", focused: true },
  "the commit echo must not eat unsent keystrokes or focus",
);

// The review ends: its controls leave the editor with it rather than
// standing as dead controls.
await setReview(false);
diag = await diagnostics();
assert.equal(diag.chunkControlCount, 0, "review: an ended review left chunk controls behind");
assert.equal(diag.reviewBarPresent, false, "review: an ended review left its bar behind");
await setReview(true);

// The narrow window: every decision must stay reachable, and neither the
// chunk controls nor the bar may push the editor into sideways scrolling.
await setLayout(NARROW);
assert.deepStrictEqual(
  await overflowing([
    "#editor .cm-content",
    ".suggestion-chunk",
    ".suggestion-review-bar",
    "#annotations-panel",
  ]),
  [],
  "review-narrow: horizontal overflow",
);
await scene.capture("review-inline-controls-narrow");

await setLayout(WIDE);
await openSceneDocument(true);
await setReview(true);
diag = await diagnostics();
assert.equal(diag.acceptCount, 2, "review-dark: the controls render in the dark theme too");
await scene.capture("review-inline-controls-dark");

// Scene 12 (12-dark-mode-complete): every surface in the dark theme in one
// frame — the locator states of plan section 3 in the composite editor, and
// beside it the pane with an open thread, both chunks' controls and the
// review bar, and the workspace panel. This scene has no light variant.
await select(SCENE_PROPOSAL_ID);
await page.evaluate(() => {
  document.querySelector("#editor-complete").style.display = "block";
});
await setLayout(DARK_COMPLETE);
const editorDiag = await page.evaluate(() => window.annotationsSceneEditorDiagnostics());
if (
  editorDiag.marks !== 5 ||
  editorDiag.markers !== 6 ||
  editorDiag.activeMarks !== 1 ||
  editorDiag.resolvedMarks !== 1 ||
  editorDiag.orphanedMarkers !== 1 ||
  editorDiag.pointMarkers !== 1 ||
  editorDiag.overlappingMarkers !== 1 ||
  editorDiag.draftMarks !== 1
) {
  throw new Error(
    `12-dark-mode-complete: not every distinguishable state (section 3) rendered once: ${JSON.stringify(editorDiag)}`,
  );
}
if (editorDiag.contentScrollWidth > editorDiag.contentClientWidth + 1) {
  throw new Error(
    `12-dark-mode-complete: editor content overflows horizontally ${JSON.stringify(editorDiag)}`,
  );
}
diag = await diagnostics();
assert.deepStrictEqual(
  diag.threadIds,
  [SCENE_PROPOSAL_ID],
  "12: the open thread renders in the dark pane",
);
assert.equal(diag.chunkControlCount, 2, "12: the chunk controls render in the dark pane");
assert.equal(diag.reviewBarPresent, true, "12: the review bar renders in the dark pane");
await scene.capture("12-dark-mode-complete");
await setLayout(WIDE);
await page.evaluate(() => {
  document.querySelector("#editor-complete").style.display = "none";
});

process.stderr.write(
  "annotations-sidebar-visual-capture: all scenes captured and structurally verified\n",
);

// S7: "Show diff" must reveal the SPECIFIC outstanding chunk this
// annotation's linked proposal produced. SCENE_PROPOSAL_ID's proposalActions
// name packet-1, which buildSceneReview links to the goal chunk alone, so
// the pane must be asked to reveal exactly that chunk's working span.
const revealedRanges = await page.evaluate(() => window.annotationsSceneClickShowProposal());
const goalFrom = (await page.evaluate(() => window.annotationsSceneWorkingText)).indexOf(
  SCENE_GOAL_TEXT,
);
assert.notEqual(goalFrom, -1, "the scene document carries the goal chunk's text");
assert.deepStrictEqual(
  revealedRanges,
  [{ from: goalFrom, to: goalFrom + SCENE_GOAL_TEXT.length }],
  "show-proposal: the pane must be asked to reveal the linked chunk",
);

// A review frozen by disk drift: the panel names the reason and offers the
// three recovery actions; the pane draws no chunk and no Accept all.
await page.evaluate(() => window.annotationsSceneSetFrozenReview(true));
diag = await diagnostics();
assert.deepStrictEqual(
  diag.frozenActionLabels,
  ["Reapply", "Return to agent", "Discard"],
  "frozen: the three recovery actions",
);
assert.equal(diag.documentAcceptAllCount, 0, "frozen: no Accept all on a frozen review");
assert.equal(diag.chunkControlCount, 0, "frozen: the pane draws no chunk controls");
await scene.capture("frozen-review-recovery");
await page.evaluate(() => window.annotationsSceneSetFrozenReview(false));

// S8/I6: Reattach only ever emits an intent (an annotation id) — the pane,
// which owns the selection, supplies the range.
await setReview(false);
await page.evaluate(() => window.annotationsSceneSetOrphanScenario(true));
await select(SCENE_ORPHANED_ID);
diag = await diagnostics();
assert.equal(diag.reattachPresent, true, "reattach: an orphaned thread offers Reattach");
const reattachAnnotationIds = await page.evaluate(() => window.annotationsSceneClickReattach());
assert.deepStrictEqual(
  reattachAnnotationIds,
  [SCENE_ORPHANED_ID],
  "reattach: exactly the orphaned annotation's id reaches the pane",
);

process.stderr.write(
  "annotations-sidebar-visual-capture: show-diff and reattach wiring verified\n",
);

// A file of collaboration state that the application cannot read: the panel
// names its document and its cause above the documents that it can read, and
// offers to move the file aside. The long cause stays inside the panel.
const UNREADABLE_BOXES = ["#annotations-panel", ".annotation-unreadable-file"];
await openSceneDocument(false);
await page.evaluate(() => window.annotationsSceneSetUnreadableFile(true));
diag = await diagnostics();
assert.deepStrictEqual(
  diag.unreadableFileNotices,
  [
    {
      file: SCENE_UNREADABLE_FILE,
      reason: "The annotations and the review of even-unimodular-lattices.md cannot be read.",
      action: "Move the file aside",
    },
  ],
  "unreadable: the panel names the document of the file and offers the action",
);
assert.equal(diag.annotationRowCount, 2, "unreadable: the readable document stays listed");
assert.deepStrictEqual(await overflowing(UNREADABLE_BOXES), [], "unreadable: no overflow");
await scene.capture("unreadable-review-file-light");
await setLayout(NARROW);
assert.deepStrictEqual(await overflowing(UNREADABLE_BOXES), [], "unreadable: no narrow overflow");
await scene.capture("unreadable-review-file-narrow");
await setLayout(WIDE);

const setAsideRequest = await page.evaluate(() => window.annotationsSceneClickSetAside());
assert.deepStrictEqual(
  setAsideRequest,
  { channel: "set-aside-collaboration-sidecar", message: { file: SCENE_UNREADABLE_FILE } },
  "set-aside: the click asks the provider to move exactly that file",
);
diag = await diagnostics();
assert.deepStrictEqual(diag.unreadableFileNotices, [], "set-aside: the notice goes away");
assert.equal(diag.toasts.length, 1, "set-aside: one message says where the file is");
assert.equal(diag.annotationRowCount, 2, "set-aside: the readable document stays listed");
await scene.capture("unreadable-review-file-set-aside");

await openSceneDocument(true);
await page.evaluate(() => window.annotationsSceneSetUnreadableFile(true));
assert.deepStrictEqual(await overflowing(UNREADABLE_BOXES), [], "unreadable: no dark overflow");
await scene.capture("unreadable-review-file-dark");

process.stderr.write("annotations-sidebar-visual-capture: unreadable review file verified\n");

// A file of collaboration state whose document has no file: the panel names
// the document and its path above the documents of the workspace, and offers
// to move the file aside. The long path stays inside the panel.
const OWNERLESS_BOXES = ["#annotations-panel", ".annotation-ownerless-file"];
const OWNERLESS_FILE = `/home/author/.config/Zettlr-Pandoc/review-sidecars/${"5d0c7be19a44e3f2".repeat(4)}.json`;
await page.evaluate(() => window.annotationsSceneSetUnreadableFile(false));
await openSceneDocument(false);
await page.evaluate(() => window.annotationsSceneSetOwnerlessFile(true));
diag = await diagnostics();
assert.deepStrictEqual(
  diag.ownerlessFileNotices,
  [
    {
      file: OWNERLESS_FILE,
      reason:
        "The annotations and the review of root-systems-and-their-weyl-groups.md belong to no document: no file is at that path.",
      path: "/home/author/notes/lattice-theory/definite/root-systems-and-their-weyl-groups.md",
      action: "Move the file aside",
    },
  ],
  "ownerless: the panel names the document that has no file and offers the action",
);
assert.equal(diag.annotationRowCount, 2, "ownerless: the document of the workspace stays listed");
assert.deepStrictEqual(await overflowing(OWNERLESS_BOXES), [], "ownerless: no overflow");
await scene.capture("ownerless-review-file-light");
await setLayout(NARROW);
assert.deepStrictEqual(await overflowing(OWNERLESS_BOXES), [], "ownerless: no narrow overflow");
await scene.capture("ownerless-review-file-narrow");
await setLayout(WIDE);

const ownerlessToasts = diag.toasts.length;
const ownerlessRequest = await page.evaluate(() => window.annotationsSceneClickSetAsideOwnerless());
assert.deepStrictEqual(
  ownerlessRequest,
  { channel: "set-aside-collaboration-sidecar", message: { file: OWNERLESS_FILE } },
  "ownerless: the click asks the provider to move exactly that file",
);
diag = await diagnostics();
assert.deepStrictEqual(diag.ownerlessFileNotices, [], "ownerless: the notice goes away");
assert.equal(
  diag.toasts.length,
  ownerlessToasts + 1,
  "ownerless: one message says where the file is",
);

await openSceneDocument(true);
await page.evaluate(() => window.annotationsSceneSetOwnerlessFile(true));
assert.deepStrictEqual(await overflowing(OWNERLESS_BOXES), [], "ownerless: no dark overflow");
await scene.capture("ownerless-review-file-dark");

process.stderr.write("annotations-sidebar-visual-capture: review file of no document verified\n");

console.log(
  JSON.stringify({
    showProposalRevealedRanges: revealedRanges,
    reattachAnnotationIds,
    setAsideRequest,
  }),
);

await scene.close();

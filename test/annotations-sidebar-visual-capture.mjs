// Captures the M7 annotations panel structural-conformance scenes (plan
// section 4, M7's structural gate: 03/05/10/11 against mockup 4). Loads the
// webpack bundle produced by visual-build.cjs once, then drives the mounted
// AnnotationsTab's real Pinia store through the window functions the entry
// exposes (select an annotation, toggle the resolved disclosure, resize for
// the narrow-container drilldown) between screenshots.
//
// Usage: node test/annotations-sidebar-visual-capture.mjs <outputDirectory>

import { strict as assert } from 'node:assert'
import { openScene } from './visual/scene.mjs'

const SCENE_THREAD_ID = 'annotation-thread'
const SCENE_PROPOSAL_ID = 'annotation-proposal'
const SCENE_ORPHANED_ID = 'annotation-orphaned'
const SCENE_MULTITURN_ID = 'annotation-multiturn'
const SCENE_PARTIAL_ID = 'annotation-partial-proposal'
const SCENE_CHUNK_TASKS_ID = 'suggestion-tasks'
const SCENE_CHUNK_GOAL_ID = 'suggestion-goal'
const SCENE_REVIEW_ID = 'review-scene'
const SCENE_REVIEW_GENERATION = 4
const SCENE_WORKING_SHA256 = 'a'.repeat(64)
const SCENE_CHUNK_GOAL_NOTE = 'Check this against the published erratum first.'

const WIDE = { width: 440, height: 760 }
const NARROW = { width: 320, height: 760 }
const DARK_COMPLETE = { width: 900, height: 760 }

const scene = await openScene({
  ...WIDE,
  args: ['--ozone-platform=x11', '--disable-gpu']
})
const { page } = scene

async function openSceneDocument (dark) {
  const background = dark ? '#1e1e1e' : '#ffffff'
  const foreground = dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { font-family: sans-serif; box-sizing: border-box; }
    #scene-layout { display: flex; height: 100%; }
    /* Scene 12 only: hidden (and out of layout) for every other scene, so
       adding it cannot shift the M7 structural-gate captures above. */
    #editor-complete { display: none; width: 480px; height: 100%; flex-shrink: 0; overflow: hidden; }
    #app { flex: 1 1 auto; height: 100%; min-width: 0; }
  </style></head><body class="${dark ? 'dark' : ''}">
    <div id="scene-layout">
      <div id="editor-complete"></div>
      <div id="app"></div>
    </div>
    <script src="./annotations-sidebar-visual-bundle.js"></script>
  </body></html>`
  // documentTreeStore (constructed by the MainSidebar mount, for the tab
  // badge boundary proof) reads window_id from the page URL; without one,
  // RelatedFilesTab.vue/OtherFilesTab.vue throw outright on construction.
  await scene.open('annotations-sidebar-scene.html', html, { window_id: 'scene-window' })
  await page.evaluate(() => window.captureReady)
}

const diagnostics = async () => await page.evaluate(() => window.annotationsSceneDiagnostics())
const select = async id => { await page.evaluate(id => window.annotationsSceneSelect(id), id) }
const setShowResolved = async value => { await page.evaluate(value => window.annotationsSceneSetShowResolved(value), value) }
const setReview = async active => { await page.evaluate(active => window.annotationsSceneSetReview(active), active) }
const acceptChunk = async index => await page.evaluate(index => window.annotationsSceneAcceptChunk(index), index)

await openSceneDocument(false)

// Scene 03: the compact list above the detail inspector, a card's thread
// selected — the wide (list + detail) arrangement mockup 4 shows.
await select(SCENE_THREAD_ID)
let diag = await diagnostics()
if (!diag.inspectorPresent || diag.inspectorMode !== 'detail' || diag.listCardCount !== 2 || diag.openCount !== 2) {
  throw new Error(`03-selected-thread-light: unexpected diagnostics ${JSON.stringify(diag)}`)
}
await scene.capture('03-selected-thread-light')

// Scene 05: a different card selected, one whose thread carries a pending
// linked proposal — ProposalActionCard and the "Show proposal" action.
await select(SCENE_PROPOSAL_ID)
diag = await diagnostics()
if (!diag.inspectorPresent || diag.inspectorMode !== 'detail') {
  throw new Error(`05-linked-proposal-pending: unexpected diagnostics ${JSON.stringify(diag)}`)
}
await scene.capture('05-linked-proposal-pending')

// Scene 10: back to the list, resolved disclosure opened — the resolved
// card appears ONLY once expanded, behind the "View resolved" control.
await select(null)
await setShowResolved(true)
diag = await diagnostics()
if (diag.inspectorMode !== 'list' || !diag.resolvedDisclosurePresent || diag.listCardCount !== 3) {
  throw new Error(`10-resolved-annotations-view: unexpected diagnostics ${JSON.stringify(diag)}`)
}
await scene.capture('10-resolved-annotations-view')

// Scene 11: narrow container width — the drilldown arrangement. Selecting
// a card must hide the list behind the detail (and its back button)
// rather than the wide stacked layout.
await setShowResolved(false)
await select(SCENE_THREAD_ID)
await scene.setSize(NARROW.width, NARROW.height)
// Scoped to #app: the off-screen MainSidebar mount (badge proof, below)
// renders its own nested .annotation-list too. The list must still be in
// the DOM and hidden — a list that never mounted would prove nothing.
await page.waitForFunction(() => {
  const list = document.querySelector('#app .annotation-list')
  return list !== null && getComputedStyle(list).display === 'none'
}, undefined, { timeout: 5000 })
await scene.capture('11-narrow-sidebar-drilldown')

// M10 scene 04 (04-ai-reply-no-proposal): a genuinely multi-turn thread —
// owner, agent, owner, agent — carrying NO linked proposal, so
// ProposalActionCard must not mount for it.
await scene.setSize(WIDE.width, WIDE.height)
await page.evaluate(() => window.annotationsSceneSetM10CapturesScenario(true))
await select(SCENE_MULTITURN_ID)
diag = await diagnostics()
if (!diag.inspectorPresent || diag.inspectorMode !== 'detail') {
  throw new Error(`04-ai-reply-no-proposal: unexpected diagnostics ${JSON.stringify(diag)}`)
}
if (await page.locator('#app .proposal-action-card').count() > 0) {
  throw new Error('04-ai-reply-no-proposal: a thread with no linked proposal must not render ProposalActionCard')
}
await scene.capture('04-ai-reply-no-proposal')

// M10 scene 06 (06-linked-proposal-partial): two linked proposalActions,
// one already decided and one still pending — ProposalActionCard's
// "pending" reading, with the review's own remaining outstanding chunks
// visible below.
await select(SCENE_PARTIAL_ID)
diag = await diagnostics()
if (!diag.inspectorPresent || diag.suggestionChunkCount !== 2) {
  throw new Error(`06-linked-proposal-partial: unexpected diagnostics ${JSON.stringify(diag)}`)
}
const partialProposalSummary = await page.evaluate(
  () => document.querySelector('#app .proposal-action-card')?.textContent ?? null
)
if (partialProposalSummary === null || !partialProposalSummary.includes('pending')) {
  throw new Error(`06-linked-proposal-partial: expected a pending proposal summary, got ${JSON.stringify(partialProposalSummary)}`)
}
await scene.capture('06-linked-proposal-partial')

await page.evaluate(() => window.annotationsSceneSetM10CapturesScenario(false))

// M9: the review adjudication controls the editor used to carry. The
// structural gate's other half — the editor's own capture proves no
// control renders there; this proves they render HERE, and that clicking
// one raises the fenced provider request rather than deciding locally.
await select(null)
await setReview(true)
diag = await diagnostics()
if (!diag.suggestionInspectorPresent || diag.suggestionChunkCount !== 2) {
  throw new Error(`review-suggestion-inspector: the panel did not render both chunks ${JSON.stringify(diag)}`)
}
if (diag.acceptCount !== 2 || diag.rejectCount !== 2) {
  throw new Error(`review-suggestion-inspector: expected one Accept and one Reject per chunk, got ${JSON.stringify(diag)}`)
}
if (diag.massActionCount !== 2 || !diag.reviewCommentPresent) {
  throw new Error(`review-suggestion-inspector: the mass actions or the review comment are missing ${JSON.stringify(diag)}`)
}
if (diag.chunkNoteValues.length !== 2 || diag.chunkNoteValues[0] !== '' || diag.chunkNoteValues[1] !== SCENE_CHUNK_GOAL_NOTE) {
  throw new Error(`review-suggestion-inspector: a chunk note field is not prefilled from the provider ${JSON.stringify(diag.chunkNoteValues)}`)
}
await scene.capture('review-suggestion-inspector-light')

assert.deepStrictEqual(
  await acceptChunk(0),
  {
    channel: 'documents:decide-review-chunk',
    message: {
      reviewId: SCENE_REVIEW_ID,
      chunkId: SCENE_CHUNK_TASKS_ID,
      decision: 'accept',
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
      expectedWorkingSha256: SCENE_WORKING_SHA256
    }
  },
  'review-suggestion-inspector: Accept raised the wrong request'
)
// The panel decided nothing locally: only the provider's broadcast may.
diag = await diagnostics()
if (diag.suggestionChunkCount !== 2) {
  throw new Error(`review-suggestion-inspector: the panel applied a decision itself ${JSON.stringify(diag)}`)
}
if (diag.outstandingLabel !== '2 outstanding') {
  throw new Error(`review-suggestion-inspector: outstanding label reads ${JSON.stringify(diag.outstandingLabel)}`)
}

// A chunk note commits on blur, trimmed, addressing its own chunk.
assert.deepStrictEqual(
  await page.evaluate(() => window.annotationsSceneWriteChunkNote(0, '  check the constant  ')),
  {
    channel: 'documents:comment-review-chunk',
    message: {
      reviewId: SCENE_REVIEW_ID,
      chunkId: SCENE_CHUNK_TASKS_ID,
      text: 'check the constant',
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
      expectedWorkingSha256: SCENE_WORKING_SHA256
    }
  }
)

// A review-level comment commits trimmed, and fences on the generation
// alone: it adjudicates nothing and moves no text.
assert.deepStrictEqual(
  await page.evaluate(() => window.annotationsSceneWriteReviewComment('  overall note  ')),
  {
    channel: 'documents:add-review-comment',
    message: {
      reviewId: SCENE_REVIEW_ID,
      text: 'overall note',
      expectedReviewGeneration: SCENE_REVIEW_GENERATION
    }
  }
)

// Every commit is a review mutation, and its broadcast re-renders this
// panel. A reviewer still typing in a note field must keep the characters
// they have not sent, and the caret with them.
assert.deepStrictEqual(
  await page.evaluate(() => window.annotationsSceneTypeThroughEcho(0, 'first second')),
  { value: 'first second', focused: true },
  'the commit echo must not eat unsent keystrokes or focus'
)

// The review ends: its whole surface leaves with it rather than standing
// as a bar of dead controls.
await setReview(false)
diag = await diagnostics()
if (diag.suggestionInspectorPresent || diag.acceptCount !== 0) {
  throw new Error(`review-suggestion-inspector: a resolved review left controls behind ${JSON.stringify(diag)}`)
}
await setReview(true)

// The panel at its narrowest: every decision must stay reachable, and the
// chunk rows must not push the sidebar into horizontal scrolling.
await scene.setSize(NARROW.width, NARROW.height)
const overflow = await page.evaluate(() => {
  const element = document.querySelector('.suggestion-inspector')
  return { scroll: element.scrollWidth, client: element.clientWidth }
})
if (overflow.scroll > overflow.client + 1) {
  throw new Error(`review-suggestion-inspector-narrow: horizontal overflow ${JSON.stringify(overflow)}`)
}
await scene.capture('review-suggestion-inspector-narrow')

await scene.setSize(WIDE.width, WIDE.height)
await openSceneDocument(true)
await setReview(true)
diag = await diagnostics()
if (!diag.suggestionInspectorPresent || diag.acceptCount !== 2) {
  throw new Error(`review-suggestion-inspector-dark: unexpected diagnostics ${JSON.stringify(diag)}`)
}
await scene.capture('review-suggestion-inspector-dark')

// M10 scene 12 (12-dark-mode-complete): every distinguishable editor
// state (plan section 3) alongside the panel, in dark theme, in one
// frame — this scene has no light variant, so it only runs here.
await page.evaluate(() => { document.querySelector('#editor-complete').style.display = 'block' })
await scene.setSize(DARK_COMPLETE.width, DARK_COMPLETE.height)
const editorDiag = await page.evaluate(() => window.annotationsSceneEditorDiagnostics())
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
  throw new Error(`12-dark-mode-complete: not every distinguishable state (section 3) rendered once: ${JSON.stringify(editorDiag)}`)
}
if (editorDiag.contentScrollWidth > editorDiag.contentClientWidth + 1) {
  throw new Error(`12-dark-mode-complete: editor content overflows horizontally ${JSON.stringify(editorDiag)}`)
}
await scene.capture('12-dark-mode-complete')
await scene.setSize(WIDE.width, WIDE.height)
await page.evaluate(() => { document.querySelector('#editor-complete').style.display = 'none' })

console.error('annotations-sidebar-visual-capture: all ten scenes captured and structurally verified')

// M10 (S7): "Show proposal" must find and mark the SPECIFIC outstanding
// chunk this annotation's linked proposal produced — the panel was
// already visible (a review is active), so revealing it proves nothing;
// resolving the packetId link does. SCENE_PROPOSAL_ID's proposalActions
// name packet-1, which annotations-sidebar-scene-fixture.ts's
// buildSceneReview links to SCENE_CHUNK_GOAL_ID alone.
await select(SCENE_PROPOSAL_ID)
const linkedChunkIds = await page.evaluate(() => window.annotationsSceneClickShowProposal())
if (JSON.stringify(linkedChunkIds) !== JSON.stringify([SCENE_CHUNK_GOAL_ID])) {
  throw new Error(`show-proposal: expected the linked ${SCENE_CHUNK_GOAL_ID} chunk focused, got ${JSON.stringify(linkedChunkIds)}`)
}

// M10 (S8/I6): Reattach only ever emits an intent (an annotation id) —
// clicking it on the REAL, separately mounted MainSidebar.vue must
// forward that exact id. This is the boundary the milestone wires:
// AnnotationsTab's begin-reattach used to die at MainSidebar, which
// forwarded only jump-to-line.
await setReview(false)
await page.evaluate(() => window.annotationsSceneSetOrphanScenario(true))
await select(SCENE_ORPHANED_ID)
const reattachAnnotationIds = await page.evaluate(() => window.annotationsSceneClickReattachInSidebar())
if (JSON.stringify(reattachAnnotationIds) !== JSON.stringify([SCENE_ORPHANED_ID])) {
  throw new Error(`begin-reattach: expected MainSidebar to forward ${SCENE_ORPHANED_ID}, got ${JSON.stringify(reattachAnnotationIds)}`)
}

console.error('annotations-sidebar-visual-capture: show-proposal and begin-reattach wiring verified')

// Restore the base fixture session before the S10 badge read below: the
// orphan scenario just above adds a third OPEN annotation, which would
// otherwise change the badge's expected count out from under that proof.
await page.evaluate(() => window.annotationsSceneSetOrphanScenario(false))
await select(null)

// The S10 boundary proof (issue: helper-level openAnnotationCount() proof
// does not prove the rendered badge): read the annotations tab's TabBar
// badge out of a REAL, separately-mounted MainSidebar.vue sharing the
// same Pinia session as the panel above. Printed as the LAST stdout line
// so annotations-sidebar.spec.ts can parse it — every other line above
// goes to stderr for exactly this reason.
console.log(JSON.stringify({
  mainSidebarAnnotationsBadge: await page.evaluate(() => window.annotationsSceneMainSidebarBadge()),
  showProposalLinkedChunkIds: linkedChunkIds,
  beginReattachAnnotationIds: reattachAnnotationIds
}))

await scene.close()

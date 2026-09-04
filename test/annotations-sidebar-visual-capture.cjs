// Captures the M7 annotations panel structural-conformance scenes (plan
// section 4, M7's structural gate: 03/05/10/11 against mockup 4) in isolated
// offscreen Electron. Loads the webpack bundle produced by
// visual-build.cjs once, then drives the mounted
// AnnotationsTab's real Pinia store through the window functions the entry
// exposes (select an annotation, toggle the resolved disclosure, resize for
// the narrow-container drilldown) between screenshots.
//
// Usage: xvfb-run -a electron test/annotations-sidebar-visual-capture.cjs <outputDirectory>

'use strict'

const assert = require('assert').strict
const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]

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

async function page (window, dark) {
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
  const pagePath = path.join(outputDirectory, 'annotations-sidebar-scene.html')
  await fs.writeFile(pagePath, html)
  // documentTreeStore (constructed by the MainSidebar mount, for the tab
  // badge boundary proof) reads window_id from the page URL; without one,
  // RelatedFilesTab.vue/OtherFilesTab.vue throw outright on construction.
  await window.loadFile(pagePath, { query: { window_id: 'scene-window' } })
  await window.webContents.executeJavaScript('window.captureReady')
}

async function capture (window, name) {
  await new Promise(resolve => setTimeout(resolve, 150))
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${name}.png`), image.toPNG())
}

async function diagnostics (window) {
  return await window.webContents.executeJavaScript('window.annotationsSceneDiagnostics()')
}

async function select (window, annotationId) {
  await window.webContents.executeJavaScript(`window.annotationsSceneSelect(${JSON.stringify(annotationId)})`)
}

async function setShowResolved (window, value) {
  await window.webContents.executeJavaScript(`window.annotationsSceneSetShowResolved(${JSON.stringify(value)})`)
}

async function setReview (window, active) {
  await window.webContents.executeJavaScript(`window.annotationsSceneSetReview(${JSON.stringify(active)})`)
}

async function acceptChunk (window, index) {
  return await window.webContents.executeJavaScript(`window.annotationsSceneAcceptChunk(${JSON.stringify(index)})`)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: WIDE.width,
    height: WIDE.height,
    show: false,
    webPreferences: { offscreen: true },
  })

  await page(window, false)

  // Scene 03: the compact list above the detail inspector, a card's thread
  // selected — the wide (list + detail) arrangement mockup 4 shows.
  window.setSize(WIDE.width, WIDE.height)
  await select(window, SCENE_THREAD_ID)
  let diag = await diagnostics(window)
  if (!diag.inspectorPresent || diag.inspectorMode !== 'detail' || diag.listCardCount !== 2 || diag.openCount !== 2) {
    throw new Error(`03-selected-thread-light: unexpected diagnostics ${JSON.stringify(diag)}`)
  }
  await capture(window, '03-selected-thread-light')

  // Scene 05: a different card selected, one whose thread carries a pending
  // linked proposal — ProposalActionCard and the "Show proposal" action.
  await select(window, SCENE_PROPOSAL_ID)
  diag = await diagnostics(window)
  if (!diag.inspectorPresent || diag.inspectorMode !== 'detail') {
    throw new Error(`05-linked-proposal-pending: unexpected diagnostics ${JSON.stringify(diag)}`)
  }
  await capture(window, '05-linked-proposal-pending')

  // Scene 10: back to the list, resolved disclosure opened — the resolved
  // card appears ONLY once expanded, behind the "View resolved" control.
  await select(window, null)
  await setShowResolved(window, true)
  diag = await diagnostics(window)
  if (diag.inspectorMode !== 'list' || !diag.resolvedDisclosurePresent || diag.listCardCount !== 3) {
    throw new Error(`10-resolved-annotations-view: unexpected diagnostics ${JSON.stringify(diag)}`)
  }
  await capture(window, '10-resolved-annotations-view')

  // Scene 11: narrow container width — the drilldown arrangement. Selecting
  // a card must hide the list behind the detail (and its back button)
  // rather than the wide stacked layout.
  await setShowResolved(window, false)
  await select(window, SCENE_THREAD_ID)
  window.setSize(NARROW.width, NARROW.height)
  await new Promise(resolve => setTimeout(resolve, 50))
  const narrowListDisplay = await window.webContents.executeJavaScript(
    // Scoped to #app: the off-screen MainSidebar mount (badge proof, below)
    // renders its own nested .annotation-list too.
    `getComputedStyle(document.querySelector('#app .annotation-list')).display`,
  )
  if (narrowListDisplay !== 'none') {
    throw new Error(`11-narrow-sidebar-drilldown: expected the list hidden behind the detail, got display=${narrowListDisplay}`)
  }
  await capture(window, '11-narrow-sidebar-drilldown')

  // M10 scene 04 (04-ai-reply-no-proposal): a genuinely multi-turn thread —
  // owner, agent, owner, agent — carrying NO linked proposal, so
  // ProposalActionCard must not mount for it.
  window.setSize(WIDE.width, WIDE.height)
  await window.webContents.executeJavaScript('window.annotationsSceneSetM10CapturesScenario(true)')
  await select(window, SCENE_MULTITURN_ID)
  diag = await diagnostics(window)
  if (!diag.inspectorPresent || diag.inspectorMode !== 'detail') {
    throw new Error(`04-ai-reply-no-proposal: unexpected diagnostics ${JSON.stringify(diag)}`)
  }
  const hasProposalCard = await window.webContents.executeJavaScript(
    `document.querySelector('#app .proposal-action-card') !== null`,
  )
  if (hasProposalCard) {
    throw new Error('04-ai-reply-no-proposal: a thread with no linked proposal must not render ProposalActionCard')
  }
  await capture(window, '04-ai-reply-no-proposal')

  // M10 scene 06 (06-linked-proposal-partial): two linked proposalActions,
  // one already decided and one still pending — ProposalActionCard's
  // "pending" reading, with the review's own remaining outstanding chunks
  // visible below.
  await select(window, SCENE_PARTIAL_ID)
  diag = await diagnostics(window)
  if (!diag.inspectorPresent || diag.suggestionChunkCount !== 2) {
    throw new Error(`06-linked-proposal-partial: unexpected diagnostics ${JSON.stringify(diag)}`)
  }
  const partialProposalSummary = await window.webContents.executeJavaScript(
    `document.querySelector('#app .proposal-action-card')?.textContent ?? null`,
  )
  if (partialProposalSummary === null || !partialProposalSummary.includes('pending')) {
    throw new Error(`06-linked-proposal-partial: expected a pending proposal summary, got ${JSON.stringify(partialProposalSummary)}`)
  }
  await capture(window, '06-linked-proposal-partial')

  await window.webContents.executeJavaScript('window.annotationsSceneSetM10CapturesScenario(false)')
  await select(window, null)

  // M9: the review adjudication controls the editor used to carry. The
  // structural gate's other half — the editor's own capture proves no
  // control renders there; this proves they render HERE, and that clicking
  // one raises the fenced provider request rather than deciding locally.
  await select(window, null)
  window.setSize(WIDE.width, WIDE.height)
  await setReview(window, true)
  diag = await diagnostics(window)
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
  await capture(window, 'review-suggestion-inspector-light')

  const request = await acceptChunk(window, 0)
  const expected = {
    channel: 'documents:decide-review-chunk',
    message: {
      reviewId: SCENE_REVIEW_ID,
      chunkId: SCENE_CHUNK_TASKS_ID,
      decision: 'accept',
      expectedReviewGeneration: SCENE_REVIEW_GENERATION,
      expectedWorkingSha256: SCENE_WORKING_SHA256,
    },
  }
  assert.deepStrictEqual(
    request,
    expected,
    `review-suggestion-inspector: Accept raised ${JSON.stringify(request)}`,
  )
  // The panel decided nothing locally: only the provider's broadcast may.
  diag = await diagnostics(window)
  if (diag.suggestionChunkCount !== 2) {
    throw new Error(`review-suggestion-inspector: the panel applied a decision itself ${JSON.stringify(diag)}`)
  }
  if (diag.outstandingLabel !== '2 outstanding') {
    throw new Error(`review-suggestion-inspector: outstanding label reads ${JSON.stringify(diag.outstandingLabel)}`)
  }

  // A chunk note commits on blur, trimmed, addressing its own chunk.
  assert.deepStrictEqual(
    await window.webContents.executeJavaScript(
      `window.annotationsSceneWriteChunkNote(0, "  check the constant  ")`,
    ),
    {
      channel: 'documents:comment-review-chunk',
      message: {
        reviewId: SCENE_REVIEW_ID,
        chunkId: SCENE_CHUNK_TASKS_ID,
        text: 'check the constant',
        expectedReviewGeneration: SCENE_REVIEW_GENERATION,
        expectedWorkingSha256: SCENE_WORKING_SHA256,
      },
    },
  )

  // A review-level comment commits trimmed, and fences on the generation
  // alone: it adjudicates nothing and moves no text.
  assert.deepStrictEqual(
    await window.webContents.executeJavaScript(
      `window.annotationsSceneWriteReviewComment("  overall note  ")`,
    ),
    {
      channel: 'documents:add-review-comment',
      message: {
        reviewId: SCENE_REVIEW_ID,
        text: 'overall note',
        expectedReviewGeneration: SCENE_REVIEW_GENERATION,
      },
    },
  )

  // Every commit is a review mutation, and its broadcast re-renders this
  // panel. A reviewer still typing in a note field must keep the characters
  // they have not sent, and the caret with them.
  const throughEcho = await window.webContents.executeJavaScript(
    `window.annotationsSceneTypeThroughEcho(0, "first second")`,
  )
  assert.deepStrictEqual(
    throughEcho,
    { value: 'first second', focused: true },
    'the commit echo must not eat unsent keystrokes or focus',
  )

  // The review ends: its whole surface leaves with it rather than standing
  // as a bar of dead controls.
  await setReview(window, false)
  diag = await diagnostics(window)
  if (diag.suggestionInspectorPresent || diag.acceptCount !== 0) {
    throw new Error(`review-suggestion-inspector: a resolved review left controls behind ${JSON.stringify(diag)}`)
  }
  await setReview(window, true)

  // The panel at its narrowest: every decision must stay reachable, and the
  // chunk rows must not push the sidebar into horizontal scrolling.
  window.setSize(NARROW.width, NARROW.height)
  await new Promise(resolve => setTimeout(resolve, 50))
  const overflow = await window.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.suggestion-inspector'); return { scroll: el.scrollWidth, client: el.clientWidth } })()`,
  )
  if (overflow.scroll > overflow.client + 1) {
    throw new Error(`review-suggestion-inspector-narrow: horizontal overflow ${JSON.stringify(overflow)}`)
  }
  await capture(window, 'review-suggestion-inspector-narrow')

  window.setSize(WIDE.width, WIDE.height)
  await page(window, true)
  await setReview(window, true)
  diag = await diagnostics(window)
  if (!diag.suggestionInspectorPresent || diag.acceptCount !== 2) {
    throw new Error(`review-suggestion-inspector-dark: unexpected diagnostics ${JSON.stringify(diag)}`)
  }
  await capture(window, 'review-suggestion-inspector-dark')

  // M10 scene 12 (12-dark-mode-complete): every distinguishable editor
  // state (plan section 3) alongside the panel, in dark theme, in one
  // frame — this scene has no light variant, so it only runs here.
  await window.webContents.executeJavaScript(`document.querySelector('#editor-complete').style.display = 'block'`)
  window.setSize(DARK_COMPLETE.width, DARK_COMPLETE.height)
  await new Promise(resolve => setTimeout(resolve, 100))
  const editorDiag = await window.webContents.executeJavaScript('window.annotationsSceneEditorDiagnostics()')
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
  await capture(window, '12-dark-mode-complete')
  window.setSize(WIDE.width, WIDE.height)
  await window.webContents.executeJavaScript(`document.querySelector('#editor-complete').style.display = 'none'`)

  console.error('annotations-sidebar-visual-capture: all ten scenes captured and structurally verified')

  // M10 (S7): "Show proposal" must find and mark the SPECIFIC outstanding
  // chunk this annotation's linked proposal produced — the panel was
  // already visible (a review is active), so revealing it proves nothing;
  // resolving the packetId link does. SCENE_PROPOSAL_ID's proposalActions
  // name packet-1, which annotations-sidebar-scene-fixture.ts's
  // buildSceneReview links to SCENE_CHUNK_GOAL_ID alone.
  await select(window, SCENE_PROPOSAL_ID)
  const linkedChunkIds = await window.webContents.executeJavaScript('window.annotationsSceneClickShowProposal()')
  if (JSON.stringify(linkedChunkIds) !== JSON.stringify([SCENE_CHUNK_GOAL_ID])) {
    throw new Error(`show-proposal: expected the linked ${SCENE_CHUNK_GOAL_ID} chunk focused, got ${JSON.stringify(linkedChunkIds)}`)
  }

  // M10 (S8/I6): Reattach only ever emits an intent (an annotation id) —
  // clicking it on the REAL, separately mounted MainSidebar.vue must
  // forward that exact id. This is the boundary the milestone wires:
  // AnnotationsTab's begin-reattach used to die at MainSidebar, which
  // forwarded only jump-to-line.
  await setReview(window, false)
  await window.webContents.executeJavaScript('window.annotationsSceneSetOrphanScenario(true)')
  await select(window, SCENE_ORPHANED_ID)
  const reattachAnnotationIds = await window.webContents.executeJavaScript('window.annotationsSceneClickReattachInSidebar()')
  if (JSON.stringify(reattachAnnotationIds) !== JSON.stringify([SCENE_ORPHANED_ID])) {
    throw new Error(`begin-reattach: expected MainSidebar to forward ${SCENE_ORPHANED_ID}, got ${JSON.stringify(reattachAnnotationIds)}`)
  }

  console.error('annotations-sidebar-visual-capture: show-proposal and begin-reattach wiring verified')

  // Restore the base fixture session before the S10 badge read below: the
  // orphan scenario just above adds a third OPEN annotation, which would
  // otherwise change the badge's expected count out from under that proof.
  await window.webContents.executeJavaScript('window.annotationsSceneSetOrphanScenario(false)')
  await select(window, null)

  // The S10 boundary proof (issue: helper-level openAnnotationCount() proof
  // does not prove the rendered badge): read the annotations tab's TabBar
  // badge out of a REAL, separately-mounted MainSidebar.vue sharing the
  // same Pinia session as the panel above. Printed as the LAST stdout line
  // so annotations-sidebar.spec.ts can parse it — every other line above
  // goes to stderr for exactly this reason.
  const mainSidebarBadge = await window.webContents.executeJavaScript('window.annotationsSceneMainSidebarBadge()')
  console.log(JSON.stringify({
    mainSidebarAnnotationsBadge: mainSidebarBadge,
    showProposalLinkedChunkIds: linkedChunkIds,
    beginReattachAnnotationIds: reattachAnnotationIds,
  }))

  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

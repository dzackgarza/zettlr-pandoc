// Drives the Mod-P reference search overlay with REAL Chromium keyboard
// input, modeled on editor-pandoc-div-click-probe.mjs. Loads the webpack
// bundle produced by visual-build.cjs, feeds the entry the raw
// reference-workspace fixture documents, types the fuzzy query, presses
// Enter, screenshots the rendered overlay, and prints one JSON result line
// the spec asserts on. When the overlay component does not exist (the Phase
// 3b red), the entry reports that as structured data and this probe still
// exits 0 with a complete result object — the spec fails on assertions, not
// on a crash.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const QUERY = 'kodemb'
// The reverse-lookup scene (issue #1 Phase 8): the key whose citing
// locations the badge-opened overlay must present. thm:torelli is cited
// from Halphen_Surfaces.md and Standalone_Notes.md (and is duplicate-
// DEFINED across projects — reverse lookup presents citing locations
// regardless of the definition's resolution state).
const KEYED_REQUEST_KEY = 'thm:torelli'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'reference-workspace')
const read = documentPath => ({ path: documentPath, content: readFileSync(documentPath, 'utf-8') })

// DELIBERATELY fed with the other-Project document FIRST (review A3): a
// broken overlay that ignores the ranking context and lists the feed order
// must fail the current-Project-first assertions.
const documents = [
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md')
].map(read)

// The US-16 ranking context of the plain scene: Mod-P invoked from
// Theorems.md with both fixture Project roots visible.
const searchContext = {
  activeDocumentPath: path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  projectRoots: [
    {
      rootPath: path.join(fixtureRoot, 'ProjectA'),
      files: ['Theorems.md', 'Coble_Lattice_Table.md', 'Halphen_Surfaces.md']
    },
    {
      rootPath: path.join(fixtureRoot, 'ProjectB'),
      files: ['Other_Paper.md']
    }
  ]
}

// The keyed scene spans the WHOLE workspace: the citing locations live in
// documents the plain Mod-P scene does not load.
const allDocuments = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectA', 'Coble_Lattice_Table.md'),
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md')
].map(read)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
  </style></head><body><main id="app"></main><script src="./reference-search-overlay-bundle.js"></script></body></html>`

const view = await openScene({
  width: 1100,
  height: 760,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})
const { page } = view

const focusWindow = async () => {
  await view.browserWindow.evaluate(window => {
    window.focus()
    window.webContents.focus()
  })
}

await view.open('reference-search-overlay.html', PAGE)

const readiness = await page.evaluate(() => typeof window.referenceSearchProbeMount)
if (readiness !== 'function') {
  throw new Error(`reference-search-overlay-entry did not initialize (referenceSearchProbeMount is ${readiness})`)
}

const mountReport = await page.evaluate(
  args => window.referenceSearchProbeMount(args.documents, args.searchContext),
  { documents, searchContext }
)

let initialState = { query: null, helpAffordancePresent: false, rows: [] }
let state = { query: null, helpAffordancePresent: false, rows: [] }
let jumpIntents = []
let openHelpCount = 0
const screenshots = []
if (mountReport.componentAvailable === true) {
  await focusWindow()
  // The empty query lists EVERY workspace definition: the review A3
  // current-Project ranking and the Project markers are asserted on this
  // initial state.
  initialState = await page.evaluate(() => window.referenceSearchProbeState())
  await view.capture('reference-search-overlay-initial')
  screenshots.push('reference-search-overlay-initial.png')

  // Scroll the marked other-Project rows into view so the Project marker
  // presentation is visually inspectable (review A3).
  await page.locator('[data-reference-key]').last().scrollIntoViewIfNeeded()
  await view.capture('reference-search-overlay-project-markers')
  screenshots.push('reference-search-overlay-project-markers.png')
  await page.locator('[data-reference-key]').first().scrollIntoViewIfNeeded()

  await page.keyboard.type(QUERY)
  state = await page.evaluate(() => window.referenceSearchProbeState())
  await view.capture('reference-search-overlay-query')
  screenshots.push('reference-search-overlay-query.png')

  // The overlay's quick-help affordance (review A2, US-06): a real click
  // on [data-open-help] must emit exactly one 'open-help'. This runs
  // BEFORE Enter: the entry mirrors App.vue's jump handling by closing
  // the overlay, so nothing would be left to click afterwards.
  openHelpCount = await page.evaluate(() => {
    document.querySelector('.reference-search-overlay [data-open-help]')?.click()
    return window.referenceSearchProbeOpenHelpCount()
  })
  await view.capture('reference-search-overlay-help-affordance')
  screenshots.push('reference-search-overlay-help-affordance.png')

  await page.keyboard.press('Enter')
  jumpIntents = await page.evaluate(() => window.referenceSearchProbeJumpIntents())
  // The post-Enter frame shows a REAL state change (ledger C4): the jump
  // intent closed the overlay, exactly as App.vue's v-on:jump handler
  // does. Fail loudly if the overlay is somehow still mounted — that
  // would make this frame a meaningless duplicate of the query frame.
  if (await page.evaluate(() => window.referenceSearchProbeOverlayPresent()) === true) {
    throw new Error('The overlay must close on the Enter jump before the closed-state frame')
  }
  await view.capture('reference-search-overlay-after-enter-closed')
  screenshots.push('reference-search-overlay-after-enter-closed.png')
}

// ——— Reverse-lookup scene (issue #1 Phase 8): reload for a fresh JS
// context, then mount the overlay pre-keyed on a definition, exactly as
// the badge-relayed openReferenceSearchEffect.of({ key }) opens it.
await view.open('reference-search-overlay.html', PAGE)
const keyedReadiness = await page.evaluate(() => typeof window.referenceSearchProbeMountKeyed)
if (keyedReadiness !== 'function') {
  throw new Error(`reference-search-overlay-entry did not initialize the keyed scene (referenceSearchProbeMountKeyed is ${keyedReadiness})`)
}

const keyedMountReport = await page.evaluate(
  args => window.referenceSearchProbeMountKeyed(args.documents, args.key),
  { documents: allDocuments, key: KEYED_REQUEST_KEY }
)

let keyedState = { query: null, mode: null, rows: [] }
let keyedJumpIntents = []
if (keyedMountReport.componentAvailable === true) {
  await focusWindow()
  keyedState = await page.evaluate(() => window.referenceSearchProbeKeyedState())
  await view.capture('reference-search-overlay-citing-locations')
  screenshots.push('reference-search-overlay-citing-locations.png')

  await page.keyboard.press('Enter')
  keyedJumpIntents = await page.evaluate(() => window.referenceSearchProbeJumpIntents())
  // As in the plain scene, the citing-location jump closes the overlay
  // (App.vue's v-on:jump), so this frame captures the real closed state.
  if (await page.evaluate(() => window.referenceSearchProbeOverlayPresent()) === true) {
    throw new Error('The keyed overlay must close on the Enter jump before the closed-state frame')
  }
  await view.capture('reference-search-overlay-citing-jump-closed')
  screenshots.push('reference-search-overlay-citing-jump-closed.png')
}

process.stdout.write(`${JSON.stringify({
  componentAvailable: mountReport.componentAvailable === true,
  componentFailure: mountReport.componentFailure ?? null,
  expectedIntent: mountReport.expectedIntent ?? null,
  query: state.query,
  rows: state.rows,
  jumpIntents,
  initialState,
  openHelpCount,
  searchContext,
  keyed: {
    componentAvailable: keyedMountReport.componentAvailable === true,
    componentFailure: keyedMountReport.componentFailure ?? null,
    requestedKey: KEYED_REQUEST_KEY,
    expectedCitingLocations: keyedMountReport.expectedCitingLocations ?? [],
    query: keyedState.query,
    mode: keyedState.mode,
    rows: keyedState.rows,
    jumpIntents: keyedJumpIntents
  },
  screenshots
})}\n`)
await view.close()

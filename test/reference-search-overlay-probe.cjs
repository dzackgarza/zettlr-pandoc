'use strict'

// Drives the Mod-P reference search overlay with REAL Chromium keyboard
// input (webContents.sendInputEvent), modeled on
// editor-pandoc-div-click-probe.cjs. Loads the webpack bundle produced by
// reference-search-overlay-build.cjs, feeds the entry the raw
// reference-workspace fixture documents, types the fuzzy query, presses
// Enter, screenshots the rendered overlay, and prints one JSON result line
// the spec asserts on. When the overlay component does not exist (the Phase
// 3b red), the entry reports that as structured data and this probe still
// exits 0 with a complete result object — the spec fails on assertions, not
// on a crash.

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const { readFileSync } = require('fs')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const QUERY = 'kodemb'
// The reverse-lookup scene (issue #1 Phase 8): the key whose citing
// locations the badge-opened overlay must present. thm:torelli is cited
// from Halphen_Surfaces.md and Standalone_Notes.md (and is duplicate-
// DEFINED across projects — reverse lookup presents citing locations
// regardless of the definition's resolution state).
const KEYED_REQUEST_KEY = 'thm:torelli'

const fixtureRoot = path.join(__dirname, 'fixtures', 'reference-workspace')
// DELIBERATELY fed with the other-Project document FIRST (review A3): a
// broken overlay that ignores the ranking context and lists the feed order
// must fail the current-Project-first assertions.
const documents = [
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
].map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8'),
}))

// The US-16 ranking context of the plain scene: Mod-P invoked from
// Theorems.md with both fixture Project roots visible.
const searchContext = {
  activeDocumentPath: path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  projectRoots: [
    {
      rootPath: path.join(fixtureRoot, 'ProjectA'),
      files: [ 'Theorems.md', 'Coble_Lattice_Table.md', 'Halphen_Surfaces.md' ],
    },
    {
      rootPath: path.join(fixtureRoot, 'ProjectB'),
      files: ['Other_Paper.md'],
    },
  ],
}

// The keyed scene spans the WHOLE workspace: the citing locations live in
// documents the plain Mod-P scene does not load.
const allDocuments = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectA', 'Coble_Lattice_Table.md'),
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md'),
].map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8'),
}))

async function nextFrame (window) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

function sendKey (window, keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window.webContents.sendInputEvent({ type: 'char', keyCode })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}

async function screenshot (window, name) {
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, name), image.toPNG())
  return name
}

app.setPath('userData', path.join(outputDirectory, 'user-data'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: { offscreen: true },
  })
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
  </style></head><body><main id="app"></main><script src="./reference-search-overlay-bundle.js"></script></body></html>`
  const pagePath = path.join(outputDirectory, 'reference-search-overlay.html')
  await fs.writeFile(pagePath, page)
  await window.loadFile(pagePath)

  const readiness = await window.webContents.executeJavaScript('typeof window.referenceSearchProbeMount')
  if (readiness !== 'function') {
    throw new Error(`reference-search-overlay-entry did not initialize (referenceSearchProbeMount is ${readiness})`)
  }

  const mountReport = await window.webContents.executeJavaScript(
    `window.referenceSearchProbeMount(${JSON.stringify(documents)}, ${JSON.stringify(searchContext)})`
  )

  let initialState = { query: null, helpAffordancePresent: false, rows: [] }
  let state = { query: null, helpAffordancePresent: false, rows: [] }
  let jumpIntents = []
  let openHelpCount = 0
  const screenshots = []
  if (mountReport.componentAvailable === true) {
    window.focus()
    window.webContents.focus()
    await nextFrame(window)
    // The empty query lists EVERY workspace definition: the review A3
    // current-Project ranking and the Project markers are asserted on this
    // initial state.
    initialState = await window.webContents.executeJavaScript('window.referenceSearchProbeState()')
    screenshots.push(await screenshot(window, 'reference-search-overlay-initial.png'))

    // Scroll the marked other-Project rows into view so the Project marker
    // presentation is visually inspectable (review A3).
    await window.webContents.executeJavaScript(
      "(() => { const rows = document.querySelectorAll('[data-reference-key]'); rows[rows.length - 1]?.scrollIntoView(); })()"
    )
    await nextFrame(window)
    screenshots.push(await screenshot(window, 'reference-search-overlay-project-markers.png'))
    await window.webContents.executeJavaScript(
      "(() => { const rows = document.querySelectorAll('[data-reference-key]'); rows[0]?.scrollIntoView(); })()"
    )
    await nextFrame(window)

    for (const character of QUERY) {
      sendKey(window, character)
    }
    await nextFrame(window)
    state = await window.webContents.executeJavaScript('window.referenceSearchProbeState()')
    screenshots.push(await screenshot(window, 'reference-search-overlay-query.png'))

    // The overlay's quick-help affordance (review A2, US-06): a real click
    // on [data-open-help] must emit exactly one 'open-help'. This runs
    // BEFORE Enter: the entry mirrors App.vue's jump handling by closing
    // the overlay, so nothing would be left to click afterwards.
    openHelpCount = await window.webContents.executeJavaScript(
      "(() => { const link = document.querySelector('.reference-search-overlay [data-open-help]'); if (link !== null) { link.click() } return window.referenceSearchProbeOpenHelpCount() })()"
    )
    screenshots.push(await screenshot(window, 'reference-search-overlay-help-affordance.png'))

    sendKey(window, 'Return')
    await nextFrame(window)
    jumpIntents = await window.webContents.executeJavaScript('window.referenceSearchProbeJumpIntents()')
    // The post-Enter frame shows a REAL state change (ledger C4): the jump
    // intent closed the overlay, exactly as App.vue's v-on:jump handler
    // does. Fail loudly if the overlay is somehow still mounted — that
    // would make this frame a meaningless duplicate of the query frame.
    const overlayStillPresent = await window.webContents.executeJavaScript('window.referenceSearchProbeOverlayPresent()')
    if (overlayStillPresent === true) {
      throw new Error('The overlay must close on the Enter jump before the closed-state frame')
    }
    screenshots.push(await screenshot(window, 'reference-search-overlay-after-enter-closed.png'))
  }

  // ——— Reverse-lookup scene (issue #1 Phase 8): reload for a fresh JS
  // context, then mount the overlay pre-keyed on a definition, exactly as
  // the badge-relayed openReferenceSearchEffect.of({ key }) opens it.
  await window.loadFile(pagePath)
  const keyedReadiness = await window.webContents.executeJavaScript('typeof window.referenceSearchProbeMountKeyed')
  if (keyedReadiness !== 'function') {
    throw new Error(`reference-search-overlay-entry did not initialize the keyed scene (referenceSearchProbeMountKeyed is ${keyedReadiness})`)
  }

  const keyedMountReport = await window.webContents.executeJavaScript(
    `window.referenceSearchProbeMountKeyed(${JSON.stringify(allDocuments)}, ${JSON.stringify(KEYED_REQUEST_KEY)})`
  )

  let keyedState = { query: null, mode: null, rows: [] }
  let keyedJumpIntents = []
  if (keyedMountReport.componentAvailable === true) {
    window.focus()
    window.webContents.focus()
    await nextFrame(window)
    keyedState = await window.webContents.executeJavaScript('window.referenceSearchProbeKeyedState()')
    screenshots.push(await screenshot(window, 'reference-search-overlay-citing-locations.png'))

    sendKey(window, 'Return')
    await nextFrame(window)
    keyedJumpIntents = await window.webContents.executeJavaScript('window.referenceSearchProbeJumpIntents()')
    // As in the plain scene, the citing-location jump closes the overlay
    // (App.vue's v-on:jump), so this frame captures the real closed state.
    const keyedOverlayStillPresent = await window.webContents.executeJavaScript('window.referenceSearchProbeOverlayPresent()')
    if (keyedOverlayStillPresent === true) {
      throw new Error('The keyed overlay must close on the Enter jump before the closed-state frame')
    }
    screenshots.push(await screenshot(window, 'reference-search-overlay-citing-jump-closed.png'))
  }

  const result = {
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
      jumpIntents: keyedJumpIntents,
    },
    screenshots,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

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

const fixtureRoot = path.join(__dirname, 'fixtures', 'reference-workspace')
const documents = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
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
    `window.referenceSearchProbeMount(${JSON.stringify(documents)})`
  )

  let state = { query: null, rows: [] }
  let jumpIntents = []
  const screenshots = []
  if (mountReport.componentAvailable === true) {
    window.focus()
    window.webContents.focus()
    await nextFrame(window)
    screenshots.push(await screenshot(window, 'reference-search-overlay-initial.png'))

    for (const character of QUERY) {
      sendKey(window, character)
    }
    await nextFrame(window)
    state = await window.webContents.executeJavaScript('window.referenceSearchProbeState()')
    screenshots.push(await screenshot(window, 'reference-search-overlay-query.png'))

    sendKey(window, 'Return')
    await nextFrame(window)
    jumpIntents = await window.webContents.executeJavaScript('window.referenceSearchProbeJumpIntents()')
    screenshots.push(await screenshot(window, 'reference-search-overlay-after-enter.png'))
  }

  const result = {
    componentAvailable: mountReport.componentAvailable === true,
    componentFailure: mountReport.componentFailure ?? null,
    expectedIntent: mountReport.expectedIntent ?? null,
    query: state.query,
    rows: state.rows,
    jumpIntents,
    screenshots,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

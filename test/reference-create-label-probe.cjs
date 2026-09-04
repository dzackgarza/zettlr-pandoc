'use strict'

// Drives the Create-reference-label dialog and the definition key-edit
// prompt scene with REAL Chromium keyboard input
// (webContents.sendInputEvent), modeled on
// reference-search-overlay-probe.cjs. Loads the webpack bundle produced by
// visual-build.cjs, mounts the dialog with the raw
// reference-workspace fixture documents, appends to the proposed slug,
// presses Enter, runs the key-edit prompt scene, screenshots the rendered
// states, and prints one JSON result line the spec asserts on. While the
// production surfaces do not exist (the Phase 6 red), the entry reports
// that as structured data and this probe still exits 0 with a complete
// result object — the spec fails on assertions, not on a crash.

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const { readFileSync } = require('fs')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
// 'torelli' (proposed, taken: thm:torelli is defined twice) + '-note'
// (available: thm:torelli-note is defined nowhere).
const APPENDED_SLUG = '-note'

const fixtureRoot = path.join(__dirname, 'fixtures', 'reference-workspace')
const documents = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectA', 'Coble_Lattice_Table.md'),
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md'),
].map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8'),
}))

const theoremsDocument = documents[0]

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
  </style></head><body><main id="app"></main><script src="./reference-create-label-bundle.js"></script></body></html>`
  const pagePath = path.join(outputDirectory, 'reference-create-label.html')
  await fs.writeFile(pagePath, page)
  await window.loadFile(pagePath)

  const readiness = await window.webContents.executeJavaScript('typeof window.createLabelProbeMount')
  if (readiness !== 'function') {
    throw new Error(`reference-create-label-entry did not initialize (createLabelProbeMount is ${readiness})`)
  }

  const mountReport = await window.webContents.executeJavaScript(
    `window.createLabelProbeMount(${JSON.stringify(documents)})`
  )

  let initialState = null
  let narrowedState = null
  let createIntents = []
  const screenshots = []
  if (mountReport.componentAvailable === true) {
    window.focus()
    window.webContents.focus()
    await nextFrame(window)
    initialState = await window.webContents.executeJavaScript('window.createLabelProbeState()')
    screenshots.push(await screenshot(window, 'create-label-initial-taken.png'))

    for (const character of APPENDED_SLUG) {
      sendKey(window, character)
    }
    await nextFrame(window)
    narrowedState = await window.webContents.executeJavaScript('window.createLabelProbeState()')
    screenshots.push(await screenshot(window, 'create-label-unique-slug.png'))

    sendKey(window, 'Return')
    await nextFrame(window)
    createIntents = await window.webContents.executeJavaScript('window.createLabelProbeCreateIntents()')
    screenshots.push(await screenshot(window, 'create-label-after-confirm.png'))
  }

  // The key-edit prompt scene runs regardless of the dialog's presence:
  // its own absence is reported inside its report object.
  const keyEditPrompt = await window.webContents.executeJavaScript(
    `window.keyEditPromptProbeRun(${JSON.stringify(theoremsDocument)})`
  )
  screenshots.push(await screenshot(window, 'key-edit-prompt-scene.png'))

  const result = {
    componentAvailable: mountReport.componentAvailable === true,
    componentFailure: mountReport.componentFailure ?? null,
    initialState,
    narrowedState,
    createIntents,
    keyEditPrompt,
    screenshots,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

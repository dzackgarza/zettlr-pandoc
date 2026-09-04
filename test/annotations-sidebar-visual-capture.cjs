// Captures the M7 annotations panel structural-conformance scenes (plan
// section 4, M7's structural gate: 03/05/10/11 against mockup 4) in isolated
// offscreen Electron. Loads the webpack bundle produced by
// annotations-sidebar-visual-build.cjs once, then drives the mounted
// AnnotationsTab's real Pinia store through the window functions the entry
// exposes (select an annotation, toggle the resolved disclosure, resize for
// the narrow-container drilldown) between screenshots.
//
// Usage: xvfb-run -a electron test/annotations-sidebar-visual-capture.cjs <outputDirectory>

'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]

const SCENE_THREAD_ID = 'annotation-thread'
const SCENE_PROPOSAL_ID = 'annotation-proposal'

const WIDE = { width: 440, height: 760 }
const NARROW = { width: 320, height: 760 }

async function page (window, dark) {
  const background = dark ? '#1e1e1e' : '#ffffff'
  const foreground = dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { font-family: sans-serif; box-sizing: border-box; }
    #app { height: 100%; }
  </style></head><body class="${dark ? 'dark' : ''}">
    <div id="app"></div>
    <script src="./annotations-sidebar-visual-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, 'annotations-sidebar-scene.html')
  await fs.writeFile(pagePath, html)
  await window.loadFile(pagePath)
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
    `getComputedStyle(document.querySelector('.annotation-list')).display`,
  )
  if (narrowListDisplay !== 'none') {
    throw new Error(`11-narrow-sidebar-drilldown: expected the list hidden behind the detail, got display=${narrowListDisplay}`)
  }
  await capture(window, '11-narrow-sidebar-drilldown')

  console.log('annotations-sidebar-visual-capture: all four scenes captured and structurally verified')
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

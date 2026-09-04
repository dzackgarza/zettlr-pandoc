'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const scenes = [
  { name: 'review-diff-wide-light', dark: false, width: 1040, height: 720 },
  { name: 'review-diff-narrow-light', dark: false, width: 430, height: 760 },
  { name: 'review-diff-wide-dark', dark: true, width: 1040, height: 720 },
  { name: 'review-diff-narrow-dark', dark: true, width: 430, height: 760 },
]

async function capture (window, scene) {
  const background = scene.dark ? '#2b2b2c' : '#ffffff'
  const foreground = scene.dark ? '#e5e7eb' : '#222222'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 24px; box-sizing: border-box; }
    #editor { max-width: 820px; margin: 0 auto; border: 1px solid ${scene.dark ? '#505050' : '#d5d5d5'}; }
    .cm-editor { min-height: 620px; height: 620px; font-size: 16px; line-height: 1.45; }
    .cm-scroller { padding: 18px 18px 48px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body class="${scene.dark ? 'dark' : ''}" data-dark="${scene.dark}">
    <main id="editor"></main><script src="./review-diff-visual-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 150))
  const diagnostics = await window.webContents.executeJavaScript('window.reviewDiffVisualDiagnostics()')
  console.log(scene.name, JSON.stringify(diagnostics))
  // The M9 structural gate, executable: both chunks are LOCATED in the
  // editor — a struck-through deletion and a highlighted insertion each —
  // and nothing in the editor can adjudicate them (I4). Adjudication is the
  // annotations panel's, captured by annotations-sidebar-visual-capture.
  if (diagnostics.chunks !== 2 || diagnostics.deletions !== 2 || diagnostics.insertions !== 2) {
    throw new Error(`${scene.name} did not render two located chunks: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.buttons !== 0 || diagnostics.inputs !== 0 || diagnostics.panels !== 0) {
    throw new Error(`${scene.name} renders an adjudication control inside the editor: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${scene.name} has horizontal editor overflow`)
  }

  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1040,
    height: 720,
    show: false,
    webPreferences: { offscreen: true },
  })
  for (const scene of scenes) {
    await capture(window, scene)
  }
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

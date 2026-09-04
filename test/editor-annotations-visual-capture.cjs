'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]

// The four scenes M5 owns (plan section 10 names). M10 assembles the full
// twelve-scene `just capture-annotations`; these are scoped to what the
// editor alone renders — no panel, no thread, no button (invariant I4).
const scenes = [
  { scene: '02-multiple-open-annotations', expect: { marks: 3, markers: 3 } },
  { scene: '07-deleted-target-point', expect: { marks: 0, markers: 1 } },
  { scene: '08-orphaned-target-warning', expect: { marks: 0, markers: 1 } },
  { scene: '09-overlapping-annotations', expect: { marks: 2, markers: 1 } }
]

async function capture (window, scene, dark) {
  const background = dark ? '#2b2b2c' : '#ffffff'
  const foreground = dark ? '#e5e7eb' : '#222222'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 24px; box-sizing: border-box; }
    #editor { max-width: 820px; margin: 0 auto; border: 1px solid ${dark ? '#505050' : '#d5d5d5'}; }
    .cm-editor { min-height: 460px; height: 460px; font-size: 16px; line-height: 1.5; }
    .cm-scroller { padding: 12px 18px 24px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-dark="${dark}" data-scene="${scene.scene}">
    <main id="editor"></main><script src="./editor-annotations-visual-bundle.js"></script>
  </body></html>`
  const name = `${scene.scene}-${dark ? 'dark' : 'light'}`
  const pagePath = path.join(outputDirectory, `${name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(900, 560)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 150))
  const diagnostics = await window.webContents.executeJavaScript('window.annotationsVisualDiagnostics()')
  console.log(name, JSON.stringify(diagnostics))
  if (diagnostics.marks !== scene.expect.marks || diagnostics.markers !== scene.expect.markers) {
    throw new Error(`${name} rendered ${diagnostics.marks} marks / ${diagnostics.markers} markers, expected ${scene.expect.marks} / ${scene.expect.markers}`)
  }
  if (diagnostics.buttons !== 0) {
    throw new Error(`${name} rendered ${diagnostics.buttons} button(s) — the editor must carry no adjudication content (I4)`)
  }
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${name} has horizontal editor overflow`)
  }

  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 560,
    show: false,
    webPreferences: { offscreen: true },
  })
  for (const scene of scenes) {
    await capture(window, scene, false)
    await capture(window, scene, true)
  }
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

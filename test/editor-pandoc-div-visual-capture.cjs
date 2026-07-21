'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const scenes = [
  { name: 'overview-light-wide', scene: 'overview', dark: false, width: 1400, height: 1050 },
  { name: 'overview-dark-wide', scene: 'overview', dark: true, width: 1400, height: 1050 },
  { name: 'overview-light-narrow', scene: 'overview', dark: false, width: 480, height: 1050 },
  { name: 'overview-dark-narrow', scene: 'overview', dark: true, width: 480, height: 1050 },
  { name: 'active-rich-source', scene: 'active', dark: false, width: 1200, height: 700 },
  { name: 'nested-light', scene: 'nested', dark: false, width: 1200, height: 800 },
  { name: 'nested-dark', scene: 'nested', dark: true, width: 1200, height: 800 },
]

async function capture (window, scene) {
  const background = scene.dark ? '#2b2b2c' : '#ffffff'
  const foreground = scene.dark ? '#e5e7eb' : '#222222'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 920px; margin: 0 auto; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-scene="${scene.scene}" data-dark="${scene.dark}">
    <main id="editor"></main><script src="./pandoc-div-visual-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 150))
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('pandoc-div-wrapper')
    const content = document.querySelector('.cm-content')
    return {
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth,
      panelWhiteSpace: panel === null ? null : getComputedStyle(panel).whiteSpace,
    }
  })()`)
  console.log(scene.name, diagnostics)
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${scene.name} has horizontal editor overflow`)
  }
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1400,
    height: 1050,
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

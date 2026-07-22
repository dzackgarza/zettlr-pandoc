'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const scenes = [
  { name: 'reference-hover-light', dark: false, width: 1200, height: 800 },
  { name: 'reference-hover-dark', dark: true, width: 1200, height: 800 },
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
  </style></head><body data-dark="${scene.dark}">
    <main id="editor"></main><script src="./reference-hover-visual-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 150))
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const tooltip = document.querySelector('.cm-tooltip.reference-hover-preview')
    const rect = tooltip === null ? null : tooltip.getBoundingClientRect()
    return {
      hasTooltip: tooltip !== null,
      hasExcerpt: document.querySelector('[data-reference-excerpt]') !== null,
      hasExpand: document.querySelector('[data-reference-expand]') !== null,
      rect: rect === null ? null : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })()`)
  console.log(scene.name, JSON.stringify(diagnostics))
  if (!diagnostics.hasTooltip || !diagnostics.hasExcerpt || !diagnostics.hasExpand) {
    throw new Error(`${scene.name} did not present the complete hover tooltip`)
  }
  const { rect, viewport } = diagnostics
  if (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height) {
    throw new Error(`${scene.name} tooltip is clipped by the window: ${JSON.stringify(rect)}`)
  }
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
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

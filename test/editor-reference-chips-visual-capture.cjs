'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const scenes = [
  { name: 'chips-occurrences-light', scene: 'occurrences', dark: false, width: 1200, height: 800 },
  { name: 'chips-occurrences-dark', scene: 'occurrences', dark: true, width: 1200, height: 800 },
  { name: 'chips-definitions-light', scene: 'definitions', dark: false, width: 1200, height: 900 },
  { name: 'chips-definitions-dark', scene: 'definitions', dark: true, width: 1200, height: 900 },
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
    <main id="editor"></main><script src="./reference-chips-visual-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 150))
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('.cm-content')
    return {
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth,
      chips: document.querySelectorAll('.reference-chip').length,
      labelBadges: document.querySelectorAll('.reference-definition-badge').length,
      countBadges: document.querySelectorAll('.reference-count-badge').length,
      positionedGroups: document.querySelectorAll('.reference-badge-group.positioned').length,
      rawMixed: document.body.textContent.includes('[@thm:torelli; @Ols04, Lem. 7.1]'),
    }
  })()`)
  console.log(scene.name, diagnostics)
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${scene.name} has horizontal editor overflow`)
  }
  if (scene.scene === 'occurrences' && diagnostics.chips === 0) {
    throw new Error(`${scene.name} rendered no reference chips`)
  }
  if (scene.scene === 'occurrences' && !diagnostics.rawMixed) {
    throw new Error(`${scene.name} did not keep the mixed cluster raw`)
  }
  if (scene.scene === 'definitions' && (diagnostics.countBadges === 0 || diagnostics.positionedGroups === 0)) {
    throw new Error(`${scene.name} rendered no positioned definition badges`)
  }
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
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

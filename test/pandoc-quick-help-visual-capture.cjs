'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const scenes = [
  { name: 'quick-help-light-wide', dark: false, width: 1180, height: 900 },
  { name: 'quick-help-dark-wide', dark: true, width: 1180, height: 900 },
  { name: 'quick-help-light-narrow', dark: false, width: 520, height: 900 },
  { name: 'quick-help-dark-narrow', dark: true, width: 520, height: 900 },
  { name: 'quick-help-light-wide-bottom', dark: false, width: 1180, height: 900, bottom: true },
  { name: 'quick-help-dark-narrow-bottom', dark: true, width: 520, height: 900, bottom: true },
]

async function capture (window, scene) {
  const background = scene.dark ? '#1d2024' : '#e9eaec'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: ${background}; }
  </style></head><body class="${scene.dark ? 'dark' : ''}">
    <main id="app"></main><script src="./pandoc-quick-help-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  const readiness = await window.webContents.executeJavaScript(`({
    type: typeof window.captureReady,
    body: document.body.innerHTML,
  })`)
  if (readiness.type !== 'object') {
    throw new Error(`${scene.name} did not initialize its capture entry: ${JSON.stringify(readiness)}`)
  }
  await window.webContents.executeJavaScript('window.captureReady')
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('.pandoc-quick-help')
    return {
      dialogClientWidth: dialog?.clientWidth,
      dialogScrollWidth: dialog?.scrollWidth,
      dialogClientHeight: dialog?.clientHeight,
      dialogScrollHeight: dialog?.scrollHeight,
      hasCloseButton: document.querySelector('button.close') !== null,
      objectRows: document.querySelectorAll('.crossref-row:not(.crossref-header)').length,
    }
  })()`)
  console.log(scene.name, diagnostics)
  if (diagnostics.dialogScrollWidth > diagnostics.dialogClientWidth + 1) {
    throw new Error(`${scene.name} has horizontal dialog overflow`)
  }
  if (!diagnostics.hasCloseButton || diagnostics.objectRows !== 4) {
    throw new Error(`${scene.name} is missing required quick-reference controls or content`)
  }
  if (scene.bottom === true) {
    await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.pandoc-quick-help')
      if (dialog !== null) dialog.scrollTop = dialog.scrollHeight
    })()`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 900,
    show: false,
    webPreferences: { offscreen: true },
  })
  window.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message))
  for (const scene of scenes) {
    await capture(window, scene)
  }
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

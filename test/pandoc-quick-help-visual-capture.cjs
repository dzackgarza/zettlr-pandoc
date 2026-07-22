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

async function capture (scene) {
  // One fresh offscreen window per scene: re-loading a same-sized window can
  // hand capturePage a stale (blank) surface, and a fresh compositor per
  // scene sidesteps that entirely.
  const window = new BrowserWindow({
    width: scene.width,
    height: scene.height,
    show: false,
    webPreferences: { offscreen: true },
  })
  window.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message))
  const background = scene.dark ? '#1d2024' : '#e9eaec'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: ${background}; }
  </style></head><body class="${scene.dark ? 'dark' : ''}">
    <main id="app"></main><script src="./pandoc-quick-help-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
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
  // Five crossref families since issue #1 added lst (the same five-family
  // contract test/pandoc-quick-help.spec.ts pins).
  if (!diagnostics.hasCloseButton || diagnostics.objectRows !== 5) {
    throw new Error(`${scene.name} is missing required quick-reference controls or content`)
  }
  if (scene.bottom === true) {
    await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.pandoc-quick-help')
      if (dialog !== null) dialog.scrollTop = dialog.scrollHeight
    })()`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const image = await captureComposited(window, scene)
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
  window.destroy()
}

/**
 * Captures the page once the offscreen compositor has actually delivered the
 * scene's content. Offscreen frames arrive on the compositor's own schedule,
 * so an immediate capturePage can grab a frame composited BEFORE the loaded
 * scene painted — a uniform, blank image. Retry around a forced repaint
 * until the frame carries real content, and fail loudly if it never does:
 * this harness must never write a blank screenshot silently.
 */
async function captureComposited (window, scene) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const painted = new Promise(resolve => window.webContents.once('paint', resolve))
    window.webContents.invalidate()
    await painted
    const image = await window.webContents.capturePage()
    const bitmap = image.toBitmap()
    if (bitmap.length >= 8) {
      const first = bitmap.readUInt32LE(0)
      for (let offset = 4; offset + 4 <= bitmap.length; offset += 4096) {
        if (bitmap.readUInt32LE(offset) !== first) {
          return image
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${scene.name} never composited visible content (every sampled frame was uniform)`)
}

// Scenes run sequentially in fresh windows: closing one must not quit the
// app before the next scene starts.
app.on('window-all-closed', () => { /* keep running until every scene captured */ })

app.whenReady().then(async () => {
  for (const scene of scenes) {
    await capture(scene)
  }
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

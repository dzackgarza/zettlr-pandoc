'use strict'

// Drives the selection-creation composer (M6) with real Chromium input,
// modeled on reference-rename-preview-probe.cjs. Loads the webpack bundle
// produced by annotation-composer-visual-build.cjs, mounts the REAL
// AnnotationCreateDialog over a real (bare) EditorView, types a real
// instruction into the textarea, and screenshots the result — the plan's
// scene 01-selection-composer, the evidence for M6's structural gate
// against mockup-2-creation-dialog.png.

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]

async function nextFrame (window) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function screenshot (window, name) {
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, name), image.toPNG())
  return name
}

app.setPath('userData', path.join(outputDirectory, 'user-data'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: { offscreen: true },
  })
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #f4f1ea; color: #222; }
    #editor-backdrop { padding: 24px; font: 14px/1.6 ui-monospace, monospace; white-space: pre-wrap; }
    .cm-editor { outline: none; }
  </style></head><body><main id="app"></main><script src="./annotation-composer-visual-bundle.js"></script></body></html>`
  const pagePath = path.join(outputDirectory, 'annotation-composer-visual.html')
  await fs.writeFile(pagePath, page)
  await window.loadFile(pagePath)

  const readiness = await window.webContents.executeJavaScript('typeof window.annotationComposerProbeMount')
  if (readiness !== 'function') {
    throw new Error(`annotation-composer-visual-entry did not initialize (annotationComposerProbeMount is ${readiness})`)
  }

  await window.webContents.executeJavaScript('window.annotationComposerProbeMount()')
  window.focus()
  window.webContents.focus()
  await nextFrame(window)

  const screenshots = []
  screenshots.push(await screenshot(window, '01-selection-composer-empty.png'))

  // The mockup shows a mid-draft instruction; typing one is a more decisive
  // proof of the field's real behavior (character counter, Save enabling)
  // than an empty textarea would be.
  await window.webContents.executeJavaScript(
    "window.annotationComposerProbeType('Expand this principle with concrete examples of transparency in AI features for our product.')"
  )
  await nextFrame(window)
  screenshots.push(await screenshot(window, '01-selection-composer.png'))

  const state = await window.webContents.executeJavaScript(`({
    excerptText: document.querySelector('[data-excerpt]')?.textContent ?? null,
    instructionValue: document.querySelector('[data-instruction]')?.value ?? null,
    counterText: document.querySelector('[data-counter]')?.textContent ?? null,
    savePresent: document.querySelector('.annotation-create-dialog [data-save]') !== null,
    cancelPresent: document.querySelector('.annotation-create-dialog [data-cancel]') !== null,
    saveDisabled: document.querySelector('.annotation-create-dialog [data-save]')?.disabled ?? null,
    fieldLabels: Array.from(document.querySelectorAll('.annotation-create-dialog .field-label')).map(el => el.textContent)
  })`)

  const result = { screenshots, state }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

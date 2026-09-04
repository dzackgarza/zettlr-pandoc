// Drives the selection-creation composer (M6) with real Chromium input.
// Loads the webpack bundle produced by visual-build.cjs, mounts the REAL
// AnnotationCreateDialog over a real (bare) EditorView, types a real
// instruction into the textarea, and screenshots the result — the plan's
// scene 01-selection-composer, the evidence for M6's structural gate
// against mockup-2-creation-dialog.png.

import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const scene = await openScene({
  width: 1200,
  height: 800,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})

await scene.open('annotation-composer-visual.html', `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #f4f1ea; color: #222; }
    #editor-backdrop { padding: 24px; font: 14px/1.6 ui-monospace, monospace; white-space: pre-wrap; }
    .cm-editor { outline: none; }
  </style></head><body><main id="app"></main><script src="./annotation-composer-visual-bundle.js"></script></body></html>`)

const readiness = await scene.page.evaluate(() => typeof window.annotationComposerProbeMount)
if (readiness !== 'function') {
  throw new Error(`annotation-composer-visual-entry did not initialize (annotationComposerProbeMount is ${readiness})`)
}

await scene.page.evaluate(() => window.annotationComposerProbeMount())
await scene.browserWindow.evaluate(window => {
  window.focus()
  window.webContents.focus()
})

const screenshots = ['01-selection-composer-empty.png']
await scene.capture('01-selection-composer-empty')

// The mockup shows a mid-draft instruction; typing one is a more decisive
// proof of the field's real behavior (character counter, Save enabling)
// than an empty textarea would be.
await scene.page.evaluate(
  instruction => window.annotationComposerProbeType(instruction),
  'Expand this principle with concrete examples of transparency in AI features for our product.'
)
screenshots.push('01-selection-composer.png')
await scene.capture('01-selection-composer')

const state = await scene.page.evaluate(() => ({
  excerptText: document.querySelector('[data-excerpt]')?.textContent ?? null,
  instructionValue: document.querySelector('[data-instruction]')?.value ?? null,
  counterText: document.querySelector('[data-counter]')?.textContent ?? null,
  savePresent: document.querySelector('.annotation-create-dialog [data-save]') !== null,
  cancelPresent: document.querySelector('.annotation-create-dialog [data-cancel]') !== null,
  saveDisabled: document.querySelector('.annotation-create-dialog [data-save]')?.disabled ?? null,
  fieldLabels: Array.from(document.querySelectorAll('.annotation-create-dialog .field-label')).map(el => el.textContent)
}))

process.stdout.write(`${JSON.stringify({ screenshots, state })}\n`)
await scene.close()

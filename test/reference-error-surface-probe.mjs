// Drives the recoverable reference-error scene in Chromium, modeled on
// reference-create-label-probe.mjs. Loads the webpack bundle produced by
// visual-build.cjs, forces a rejecting reference-provider invocation through
// the production error boundary, records the toast surface before and after
// a dismissal click, then types REAL keyboard input into the CodeMirror
// editor to prove it stayed interactive. Screenshots every state and prints
// one JSON result line the spec asserts on. While the boundary only logs
// (the Phase 8 red), the toast list stays empty and the spec fails on
// assertions, not on a crash.

import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

// Typed into the editor AFTER the dismissal attempt: interactivity proof.
const TYPED_PROOF = 'still-alive'

const view = await openScene({
  width: 1100,
  height: 760,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})

await view.open('reference-error-surface.html', `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
    #error-surface-editor { margin: 24px; background: #ffffff; border: 1px solid #c8ccd0; min-height: 200px; }
    .cm-editor { min-height: 200px; }
  </style></head><body><script src="./reference-error-surface-bundle.js"></script></body></html>`)

const readiness = await view.page.evaluate(() => typeof window.errorSurfaceProbeRun)
if (readiness !== 'function') {
  throw new Error(`reference-error-surface-entry did not initialize (errorSurfaceProbeRun is ${readiness})`)
}

const runReport = await view.page.evaluate(() => window.errorSurfaceProbeRun())

const toastsAfterFailure = await view.page.evaluate(() => window.errorSurfaceProbeToastState())
const screenshots = ['error-surface-after-failure.png']
await view.capture('error-surface-after-failure')

const dismissPerformed = await view.page.evaluate(() => window.errorSurfaceProbeDismiss())
const toastsAfterDismiss = await view.page.evaluate(() => window.errorSurfaceProbeToastState())
await view.capture('error-surface-after-dismiss')
screenshots.push('error-surface-after-dismiss.png')

// Interactivity proof: focus the real editor and type with real Chromium
// keyboard input.
await view.browserWindow.evaluate(window => {
  window.focus()
  window.webContents.focus()
})
await view.page.evaluate(() => window.errorSurfaceProbeFocusEditor())
await view.page.keyboard.type(TYPED_PROOF)
const editorText = await view.page.evaluate(() => window.errorSurfaceProbeEditorText())
await view.capture('error-surface-typing-after-dismiss')
screenshots.push('error-surface-typing-after-dismiss.png')

process.stdout.write(`${JSON.stringify({
  moduleAvailable: runReport.moduleAvailable === true,
  moduleFailure: runReport.moduleFailure ?? null,
  outcome: runReport.outcome ?? null,
  toastsAfterFailure,
  dismissPerformed,
  toastsAfterDismiss,
  typedProof: TYPED_PROOF,
  editorText,
  uncaught: await view.page.evaluate(() => window.errorSurfaceProbeUncaught()),
  screenshots
})}\n`)
await view.close()

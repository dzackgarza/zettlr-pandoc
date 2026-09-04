// Drives the rename-preview dialog with real Chromium input, modeled on
// reference-create-label-probe.mjs. Loads the webpack bundle produced by
// visual-build.cjs, mounts the dialog over the previewed fixture rename,
// screenshots the rendered preview (the contract's "rename preview"
// capture), exercises Cancel in one scene and Apply in a fresh scene, and
// prints one JSON result line the spec asserts on. While the dialog does not
// exist (the review A4 red), the entry reports that as structured data and
// this probe still exits 0 with a complete result object — the spec fails on
// assertions, not on a crash.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const OLD_KEY = 'thm:torelli'
const NEW_KEY = 'thm:torelli-headline'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'reference-workspace')
const documents = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md')
].map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8')
}))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
  </style></head><body><main id="app"></main><script src="./reference-rename-preview-bundle.js"></script></body></html>`

const view = await openScene({
  width: 1100,
  height: 760,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})

const mount = async () => await view.page.evaluate(
  args => window.renamePreviewProbeMount(args.documents, args.oldKey, args.newKey),
  { documents, oldKey: OLD_KEY, newKey: NEW_KEY }
)

await view.open('reference-rename-preview.html', PAGE)

const readiness = await view.page.evaluate(() => typeof window.renamePreviewProbeMount)
if (readiness !== 'function') {
  throw new Error(`reference-rename-preview-entry did not initialize (renamePreviewProbeMount is ${readiness})`)
}

// ——— Scene 1: preview + Cancel (commits nothing).
const mountReport = await mount()

let previewState = null
let cancelScene = null
const screenshots = []
if (mountReport.componentAvailable === true) {
  await view.browserWindow.evaluate(window => {
    window.focus()
    window.webContents.focus()
  })
  previewState = await view.page.evaluate(() => window.renamePreviewProbeState())
  await view.capture('rename-preview-dialog')
  screenshots.push('rename-preview-dialog.png')

  const cancelClicked = await view.page.evaluate(
    () => window.renamePreviewProbeClick('.rename-preview-dialog [data-cancel]')
  )
  cancelScene = {
    cancelClicked,
    events: await view.page.evaluate(() => window.renamePreviewProbeEvents())
  }
  await view.capture('rename-preview-after-cancel')
  screenshots.push('rename-preview-after-cancel.png')
}

// ——— Scene 2 (fresh JS context): preview + Apply (proceeds exactly once).
await view.open('reference-rename-preview.html', PAGE)
const applyMountReport = await mount()

let applyScene = null
if (applyMountReport.componentAvailable === true) {
  const applyClicked = await view.page.evaluate(
    () => window.renamePreviewProbeClick('.rename-preview-dialog [data-apply]')
  )
  applyScene = {
    applyClicked,
    events: await view.page.evaluate(() => window.renamePreviewProbeEvents())
  }
  await view.capture('rename-preview-after-apply')
  screenshots.push('rename-preview-after-apply.png')
}

process.stdout.write(`${JSON.stringify({
  componentAvailable: mountReport.componentAvailable === true,
  componentFailure: mountReport.componentFailure ?? null,
  oldKey: OLD_KEY,
  newKey: NEW_KEY,
  expectedFiles: mountReport.expectedFiles ?? [],
  previewState,
  cancelScene,
  applyScene,
  screenshots
})}\n`)
await view.close()

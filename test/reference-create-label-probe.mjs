// Drives the Create-reference-label dialog and the definition key-edit
// prompt scene with REAL Chromium keyboard input, modeled on
// reference-search-overlay-probe.mjs. Loads the webpack bundle produced by
// visual-build.cjs, mounts the dialog with the raw reference-workspace
// fixture documents, appends to the proposed slug, presses Enter, runs the
// key-edit prompt scene, screenshots the rendered states, and prints one
// JSON result line the spec asserts on. While the production surfaces do not
// exist (the Phase 6 red), the entry reports that as structured data and
// this probe still exits 0 with a complete result object — the spec fails on
// assertions, not on a crash.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

// 'torelli' (proposed, taken: thm:torelli is defined twice) + '-note'
// (available: thm:torelli-note is defined nowhere).
const APPENDED_SLUG = '-note'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'reference-workspace')
const documents = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectA', 'Coble_Lattice_Table.md'),
  path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md')
].map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8')
}))

const theoremsDocument = documents[0]

const view = await openScene({
  width: 1100,
  height: 760,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})

await view.open('reference-create-label.html', `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
  </style></head><body><main id="app"></main><script src="./reference-create-label-bundle.js"></script></body></html>`)

const readiness = await view.page.evaluate(() => typeof window.createLabelProbeMount)
if (readiness !== 'function') {
  throw new Error(`reference-create-label-entry did not initialize (createLabelProbeMount is ${readiness})`)
}

const mountReport = await view.page.evaluate(docs => window.createLabelProbeMount(docs), documents)

let initialState = null
let narrowedState = null
let createIntents = []
const screenshots = []
if (mountReport.componentAvailable === true) {
  await view.browserWindow.evaluate(window => {
    window.focus()
    window.webContents.focus()
  })
  initialState = await view.page.evaluate(() => window.createLabelProbeState())
  await view.capture('create-label-initial-taken')
  screenshots.push('create-label-initial-taken.png')

  await view.page.keyboard.type(APPENDED_SLUG)
  narrowedState = await view.page.evaluate(() => window.createLabelProbeState())
  await view.capture('create-label-unique-slug')
  screenshots.push('create-label-unique-slug.png')

  await view.page.keyboard.press('Enter')
  createIntents = await view.page.evaluate(() => window.createLabelProbeCreateIntents())
  await view.capture('create-label-after-confirm')
  screenshots.push('create-label-after-confirm.png')
}

// The key-edit prompt scene runs regardless of the dialog's presence:
// its own absence is reported inside its report object.
const keyEditPrompt = await view.page.evaluate(
  document => window.keyEditPromptProbeRun(document),
  theoremsDocument
)
await view.capture('key-edit-prompt-scene')
screenshots.push('key-edit-prompt-scene.png')

process.stdout.write(`${JSON.stringify({
  componentAvailable: mountReport.componentAvailable === true,
  componentFailure: mountReport.componentFailure ?? null,
  initialState,
  narrowedState,
  createIntents,
  keyEditPrompt,
  screenshots
})}\n`)
await view.close()

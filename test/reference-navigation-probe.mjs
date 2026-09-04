// Drives the Phase 5 reference navigation surface with REAL Chromium input,
// modeled on the reference-search-overlay and editor-pandoc-div-click
// probes. Loads the esbuild bundle produced from
// reference-navigation-entry.ts, feeds it the raw reference-workspace
// fixture documents plus the reference-navigation-scene fixture, performs
// ordinary clicks (edit-first parity) and platform Mod-clicks
// (Ctrl on Linux) on reference occurrences and footnotes, screenshots the
// scenes, and prints one JSON result line the spec asserts on.
//
// BOUNDARY SPLIT (issue #1 Phase 5): the page installs a window.ipc
// RECORDER before the bundle loads. It records what the renderer sends at
// the preload seam (the same seam the real preload owns) and resolves with
// undefined; it never simulates documents-provider behavior, tab
// choreography, or history. The main-process half is locked red by
// test/tab-manager-history.spec.ts against the real TabManager. While the
// renderer navigation is unimplemented (the Phase 5 red), every recorded
// surface is simply empty/null and the spec fails on assertions — this
// probe still exits 0 with a complete result object.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'reference-workspace')
const scenePath = path.join(import.meta.dirname, 'fixtures', 'reference-navigation-scene.md')
const documentPaths = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectA', 'Coble_Lattice_Table.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md'),
  scenePath
]
const documents = documentPaths.map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8')
}))
const halphenPath = documentPaths[1]
const halphenContent = documents[1].content
const sceneContent = documents[4].content

// The inline script installs the window.ipc RECORDER before the bundle
// evaluates (open-markdown-link captures window.ipc at import time). It
// records outgoing renderer requests only; nothing is simulated back.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 100%; height: 100%; background: #ffffff; color: #222; }
    /* A short host so the editor genuinely overflows and the scroll capture
       scene exercises a nonzero scrollTop. */
    #editor { height: 240px; overflow: hidden; }
    #editor .cm-editor { height: 100%; }
  </style></head><body><main id="editor"></main><script>
    window.__ipcInvocations = []
    window.ipc = {
      invoke: (channel, ...args) => {
        window.__ipcInvocations.push({ channel, args })
        return Promise.resolve(undefined)
      },
      on: () => {},
      send: () => {},
      sendSync: () => { throw new Error('sendSync is unavailable in the navigation probe') }
    }
  </script><script src="./reference-navigation-bundle.js"></script></body></html>`

const view = await openScene({
  width: 1000,
  height: 420,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})
const { page } = view

// page.mouse has no modifiers option — the modifier has to be genuinely held
// down around the click, which is also what a reader does.
const click = async (target, modifiers) => {
  for (const key of modifiers) {
    await page.keyboard.down(key)
  }
  await page.mouse.click(Math.round(target.x), Math.round(target.y))
  for (const key of modifiers) {
    await page.keyboard.up(key)
  }
}
const invocationCount = async () => (await page.evaluate(() => window.refNavProbeInvocations())).length
const invocationsSince = async start => (await page.evaluate(() => window.refNavProbeInvocations())).slice(start)

await view.open('reference-navigation.html', PAGE)

const readiness = await page.evaluate(() => typeof window.refNavProbeMount)
if (readiness !== 'function') {
  throw new Error(`reference-navigation-entry did not initialize (refNavProbeMount is ${readiness})`)
}

await view.browserWindow.evaluate(window => {
  window.focus()
  window.webContents.focus()
})

// ------------------------------------------------------------------
// Scene 1: cross-file navigation inside ProjectA/Halphen_Surfaces.md
// ------------------------------------------------------------------
await page.evaluate(args => window.refNavProbeMount(args.documents, args.path), { documents, path: halphenPath })
const screenshots = []
await view.capture('reference-navigation-cross-initial')
screenshots.push('reference-navigation-cross-initial.png')

// Edit-first parity: ordinary click on a resolved chip reveals the source.
const parityChipBefore = await page.evaluate(() => window.refNavProbeChipTarget('tbl:coble-lattices'))
let parity = {
  chipPresentBefore: parityChipBefore !== null,
  tokenRange: null,
  selectionAfterChipClick: null,
  chipSuppressedAfterClick: null,
  rawTokenVisibleAfterClick: null
}
if (parityChipBefore !== null) {
  await click(parityChipBefore, [])
  parity = {
    chipPresentBefore: true,
    tokenRange: { from: parityChipBefore.from, to: parityChipBefore.to },
    selectionAfterChipClick: await page.evaluate(() => window.refNavProbeSelection()),
    chipSuppressedAfterClick: (await page.evaluate(() => window.refNavProbeChipTarget('tbl:coble-lattices'))) === null,
    rawTokenVisibleAfterClick: await page.evaluate(() => window.refNavProbeHasVisibleText('@tbl:coble-lattices'))
  }
}
await view.capture('reference-navigation-cross-revealed')
screenshots.push('reference-navigation-cross-revealed.png')

// DocumentLocation capture: fold one paragraph, scroll, then capture.
const foldFrom = halphenContent.indexOf('The degeneration picture')
const foldTo = halphenContent.indexOf('double fiber.') + 'double fiber.'.length
await page.evaluate(range => window.refNavProbeFold(range.from, range.to), { from: foldFrom, to: foldTo })
const scrollActual = await page.evaluate(() => window.refNavProbeSetScrollTop(64))
const location = {
  foldRange: { from: foldFrom, to: foldTo },
  scrollActual,
  expected: await page.evaluate(() => window.refNavProbeExpectedLocation()),
  captured: await page.evaluate(() => window.refNavProbeCaptureLocation())
}
await page.evaluate(() => window.refNavProbeSetScrollTop(0))

// Mod-click follow on @thm:torelli: reveal the raw token first when its
// cluster rendered chips (adaptive; both paths use production behavior).
let torelliTarget = await page.evaluate(() => window.refNavProbeTextTarget('@thm:torelli'))
if (torelliTarget === null) {
  const torelliChip = await page.evaluate(() => window.refNavProbeChipTarget('thm:torelli'))
  if (torelliChip !== null) {
    await click(torelliChip, [])
    torelliTarget = await page.evaluate(() => window.refNavProbeTextTarget('@thm:torelli'))
  }
}

let crossModClick = {
  rawTokenAvailable: torelliTarget !== null,
  occurrenceRange: null,
  resolvedIntent: null,
  preJumpLocation: null,
  invocations: [],
  selectionAfter: null
}
if (torelliTarget !== null) {
  const clickPos = await page.evaluate(
    target => window.refNavProbePosAtCoords(target.x, target.y),
    torelliTarget
  )
  const invocationStart = await invocationCount()
  const preJumpLocation = await page.evaluate(() => window.refNavProbeExpectedLocation())
  await click(torelliTarget, ['Control'])
  crossModClick = {
    rawTokenAvailable: true,
    occurrenceRange: { from: torelliTarget.from, to: torelliTarget.to },
    resolvedIntent: clickPos === null ? null : await page.evaluate(pos => window.refNavProbeResolveIntentAt(pos), clickPos),
    preJumpLocation,
    invocations: await invocationsSince(invocationStart),
    selectionAfter: await page.evaluate(() => window.refNavProbeSelection())
  }
}
// No post-Mod-click screenshot (ledger C4): the Mod-click's visible
// outcome — the target document opening at the definition — is owned by
// the main-process documents provider, and this renderer-only harness
// deliberately records that boundary (window.ipc invocations above)
// instead of simulating it. Headless, the editor pane is pixel-identical
// before and after the click, so a frame here would be a meaningless
// receipt; the recorded invocations in the JSON result are the proof.

const crossFile = { parity, location, modClick: crossModClick }

// ------------------------------------------------------------------
// Scene 2: same-file navigation and footnotes in the scene fixture
// ------------------------------------------------------------------
await page.evaluate(args => window.refNavProbeMount(args.documents, args.path), { documents, path: scenePath })
await view.capture('reference-navigation-same-initial')
screenshots.push('reference-navigation-same-initial.png')

// Footnote edit-first parity: an ordinary click must NOT navigate.
const footnoteTarget = await page.evaluate(() => window.refNavProbeTextTarget('[^note]'))
let footnoteParity = { tokenAvailable: footnoteTarget !== null, tokenRange: null, selectionAfter: null, invocations: [] }
if (footnoteTarget !== null) {
  const invocationStart = await invocationCount()
  await click(footnoteTarget, [])
  footnoteParity = {
    tokenAvailable: true,
    tokenRange: { from: footnoteTarget.from, to: footnoteTarget.to },
    selectionAfter: await page.evaluate(() => window.refNavProbeSelection()),
    invocations: await invocationsSince(invocationStart)
  }
}

// Same-file Mod-click follow on the @thm:local occurrence (chip when
// rendered, raw token otherwise; both are production surfaces).
let localTarget = await page.evaluate(() => window.refNavProbeChipTarget('thm:local'))
const localChipPresent = localTarget !== null
if (localTarget === null) {
  localTarget = await page.evaluate(() => window.refNavProbeTextTarget('@thm:local'))
}
let sameModClick = { targetAvailable: localTarget !== null, chipPresent: localChipPresent, resolvedIntent: null, invocations: [], selectionAfter: null }
if (localTarget !== null) {
  const clickPos = await page.evaluate(target => window.refNavProbePosAtCoords(target.x, target.y), localTarget)
  const invocationStart = await invocationCount()
  await click(localTarget, ['Control'])
  sameModClick = {
    targetAvailable: true,
    chipPresent: localChipPresent,
    resolvedIntent: clickPos === null ? null : await page.evaluate(pos => window.refNavProbeResolveIntentAt(pos), clickPos),
    invocations: await invocationsSince(invocationStart),
    selectionAfter: await page.evaluate(() => window.refNavProbeSelection())
  }
}

// Footnote Mod-click follow: must jump to the footnote body.
const footnoteModTarget = await page.evaluate(() => window.refNavProbeTextTarget('[^note]'))
let footnoteModClick = { targetAvailable: footnoteModTarget !== null, resolvedIntent: null, invocations: [], selectionAfter: null }
if (footnoteModTarget !== null) {
  const clickPos = await page.evaluate(target => window.refNavProbePosAtCoords(target.x, target.y), footnoteModTarget)
  const invocationStart = await invocationCount()
  await click(footnoteModTarget, ['Control'])
  footnoteModClick = {
    targetAvailable: true,
    resolvedIntent: clickPos === null ? null : await page.evaluate(pos => window.refNavProbeResolveIntentAt(pos), clickPos),
    invocations: await invocationsSince(invocationStart),
    selectionAfter: await page.evaluate(() => window.refNavProbeSelection())
  }
}
await view.capture('reference-navigation-same-final')
screenshots.push('reference-navigation-same-final.png')

const sameFile = { footnoteParity, modClickReference: sameModClick, modClickFootnote: footnoteModClick, sceneContentLength: sceneContent.length }

process.stdout.write(`${JSON.stringify({ crossFile, sameFile, screenshots })}\n`)
await view.close()

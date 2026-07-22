'use strict'

// Drives the Phase 5 reference navigation surface with REAL Chromium input
// (webContents.sendInputEvent), modeled on the reference-search-overlay and
// editor-pandoc-div-click probes (same xvfb Electron invocation and sandbox
// flags). Loads the esbuild bundle produced from
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

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const { readFileSync } = require('fs')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]

const fixtureRoot = path.join(__dirname, 'fixtures', 'reference-workspace')
const scenePath = path.join(__dirname, 'fixtures', 'reference-navigation-scene.md')
const documentPaths = [
  path.join(fixtureRoot, 'ProjectA', 'Theorems.md'),
  path.join(fixtureRoot, 'ProjectA', 'Halphen_Surfaces.md'),
  path.join(fixtureRoot, 'ProjectA', 'Coble_Lattice_Table.md'),
  path.join(fixtureRoot, 'Standalone_Notes.md'),
  scenePath,
]
const documents = documentPaths.map(documentPath => ({
  path: documentPath,
  content: readFileSync(documentPath, 'utf-8'),
}))
const halphenPath = documentPaths[1]
const halphenContent = documents[1].content
const sceneContent = documents[4].content

async function nextFrame (window) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function js (window, expression) {
  return await window.webContents.executeJavaScript(expression)
}

function sendClick (window, target, modifiers) {
  const x = Math.round(target.x)
  const y = Math.round(target.y)
  window.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
  window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers })
  window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers })
}

async function screenshot (window, name) {
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, name), image.toPNG())
  return name
}

async function invocationsSince (window, start) {
  const all = await js(window, 'window.refNavProbeInvocations()')
  return all.slice(start)
}

app.setPath('userData', path.join(outputDirectory, 'user-data'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 420,
    show: true,
    webPreferences: { offscreen: true },
  })
  // The inline script installs the window.ipc RECORDER before the bundle
  // evaluates (open-markdown-link captures window.ipc at import time). It
  // records outgoing renderer requests only; nothing is simulated back.
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
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
  const pagePath = path.join(outputDirectory, 'reference-navigation.html')
  await fs.writeFile(pagePath, page)
  await window.loadFile(pagePath)

  const readiness = await js(window, 'typeof window.refNavProbeMount')
  if (readiness !== 'function') {
    throw new Error(`reference-navigation-entry did not initialize (refNavProbeMount is ${readiness})`)
  }

  window.focus()
  window.webContents.focus()

  // ------------------------------------------------------------------
  // Scene 1: cross-file navigation inside ProjectA/Halphen_Surfaces.md
  // ------------------------------------------------------------------
  await js(window, `window.refNavProbeMount(${JSON.stringify(documents)}, ${JSON.stringify(halphenPath)})`)
  await nextFrame(window)
  const screenshots = []
  screenshots.push(await screenshot(window, 'reference-navigation-cross-initial.png'))

  // Edit-first parity: ordinary click on a resolved chip reveals the source.
  const parityChipBefore = await js(window, 'window.refNavProbeChipTarget("tbl:coble-lattices")')
  let parity = {
    chipPresentBefore: parityChipBefore !== null,
    tokenRange: null,
    selectionAfterChipClick: null,
    chipSuppressedAfterClick: null,
    rawTokenVisibleAfterClick: null,
  }
  if (parityChipBefore !== null) {
    sendClick(window, parityChipBefore, [])
    await nextFrame(window)
    parity = {
      chipPresentBefore: true,
      tokenRange: { from: parityChipBefore.from, to: parityChipBefore.to },
      selectionAfterChipClick: await js(window, 'window.refNavProbeSelection()'),
      chipSuppressedAfterClick: (await js(window, 'window.refNavProbeChipTarget("tbl:coble-lattices")')) === null,
      rawTokenVisibleAfterClick: await js(window, 'window.refNavProbeHasVisibleText("@tbl:coble-lattices")'),
    }
  }
  screenshots.push(await screenshot(window, 'reference-navigation-cross-revealed.png'))

  // DocumentLocation capture: fold one paragraph, scroll, then capture.
  const foldFrom = halphenContent.indexOf('The degeneration picture')
  const foldTo = halphenContent.indexOf('double fiber.') + 'double fiber.'.length
  await js(window, `window.refNavProbeFold(${foldFrom}, ${foldTo})`)
  await nextFrame(window)
  const scrollActual = await js(window, 'window.refNavProbeSetScrollTop(64)')
  await nextFrame(window)
  const location = {
    foldRange: { from: foldFrom, to: foldTo },
    scrollActual,
    expected: await js(window, 'window.refNavProbeExpectedLocation()'),
    captured: await js(window, 'window.refNavProbeCaptureLocation()'),
  }
  await js(window, 'window.refNavProbeSetScrollTop(0)')
  await nextFrame(window)

  // Mod-click follow on @thm:torelli: reveal the raw token first when its
  // cluster rendered chips (adaptive; both paths use production behavior).
  let torelliTarget = await js(window, 'window.refNavProbeTextTarget("@thm:torelli")')
  if (torelliTarget === null) {
    const torelliChip = await js(window, 'window.refNavProbeChipTarget("thm:torelli")')
    if (torelliChip !== null) {
      sendClick(window, torelliChip, [])
      await nextFrame(window)
      torelliTarget = await js(window, 'window.refNavProbeTextTarget("@thm:torelli")')
    }
  }

  let crossModClick = {
    rawTokenAvailable: torelliTarget !== null,
    occurrenceRange: null,
    resolvedIntent: null,
    preJumpLocation: null,
    invocations: [],
    selectionAfter: null,
  }
  if (torelliTarget !== null) {
    const clickPos = await js(window, `window.refNavProbePosAtCoords(${torelliTarget.x}, ${torelliTarget.y})`)
    const invocationStart = (await js(window, 'window.refNavProbeInvocations()')).length
    const preJumpLocation = await js(window, 'window.refNavProbeExpectedLocation()')
    sendClick(window, torelliTarget, ['control'])
    await nextFrame(window)
    crossModClick = {
      rawTokenAvailable: true,
      occurrenceRange: { from: torelliTarget.from, to: torelliTarget.to },
      resolvedIntent: clickPos === null ? null : await js(window, `window.refNavProbeResolveIntentAt(${clickPos})`),
      preJumpLocation,
      invocations: await invocationsSince(window, invocationStart),
      selectionAfter: await js(window, 'window.refNavProbeSelection()'),
    }
  }
  screenshots.push(await screenshot(window, 'reference-navigation-cross-after-modclick.png'))

  const crossFile = { parity, location, modClick: crossModClick }

  // ------------------------------------------------------------------
  // Scene 2: same-file navigation and footnotes in the scene fixture
  // ------------------------------------------------------------------
  await js(window, `window.refNavProbeMount(${JSON.stringify(documents)}, ${JSON.stringify(scenePath)})`)
  await nextFrame(window)
  screenshots.push(await screenshot(window, 'reference-navigation-same-initial.png'))

  // Footnote edit-first parity: an ordinary click must NOT navigate.
  const footnoteTarget = await js(window, 'window.refNavProbeTextTarget("[^note]")')
  let footnoteParity = { tokenAvailable: footnoteTarget !== null, tokenRange: null, selectionAfter: null, invocations: [] }
  if (footnoteTarget !== null) {
    const invocationStart = (await js(window, 'window.refNavProbeInvocations()')).length
    sendClick(window, footnoteTarget, [])
    await nextFrame(window)
    footnoteParity = {
      tokenAvailable: true,
      tokenRange: { from: footnoteTarget.from, to: footnoteTarget.to },
      selectionAfter: await js(window, 'window.refNavProbeSelection()'),
      invocations: await invocationsSince(window, invocationStart),
    }
  }

  // Same-file Mod-click follow on the @thm:local occurrence (chip when
  // rendered, raw token otherwise; both are production surfaces).
  let localTarget = await js(window, 'window.refNavProbeChipTarget("thm:local")')
  const localChipPresent = localTarget !== null
  if (localTarget === null) {
    localTarget = await js(window, 'window.refNavProbeTextTarget("@thm:local")')
  }
  let sameModClick = { targetAvailable: localTarget !== null, chipPresent: localChipPresent, resolvedIntent: null, invocations: [], selectionAfter: null }
  if (localTarget !== null) {
    const clickPos = await js(window, `window.refNavProbePosAtCoords(${localTarget.x}, ${localTarget.y})`)
    const invocationStart = (await js(window, 'window.refNavProbeInvocations()')).length
    sendClick(window, localTarget, ['control'])
    await nextFrame(window)
    sameModClick = {
      targetAvailable: true,
      chipPresent: localChipPresent,
      resolvedIntent: clickPos === null ? null : await js(window, `window.refNavProbeResolveIntentAt(${clickPos})`),
      invocations: await invocationsSince(window, invocationStart),
      selectionAfter: await js(window, 'window.refNavProbeSelection()'),
    }
  }

  // Footnote Mod-click follow: must jump to the footnote body.
  const footnoteModTarget = await js(window, 'window.refNavProbeTextTarget("[^note]")')
  let footnoteModClick = { targetAvailable: footnoteModTarget !== null, resolvedIntent: null, invocations: [], selectionAfter: null }
  if (footnoteModTarget !== null) {
    const clickPos = await js(window, `window.refNavProbePosAtCoords(${footnoteModTarget.x}, ${footnoteModTarget.y})`)
    const invocationStart = (await js(window, 'window.refNavProbeInvocations()')).length
    sendClick(window, footnoteModTarget, ['control'])
    await nextFrame(window)
    footnoteModClick = {
      targetAvailable: true,
      resolvedIntent: clickPos === null ? null : await js(window, `window.refNavProbeResolveIntentAt(${clickPos})`),
      invocations: await invocationsSince(window, invocationStart),
      selectionAfter: await js(window, 'window.refNavProbeSelection()'),
    }
  }
  screenshots.push(await screenshot(window, 'reference-navigation-same-final.png'))

  const sameFile = { footnoteParity, modClickReference: sameModClick, modClickFootnote: footnoteModClick, sceneContentLength: sceneContent.length }

  const result = { crossFile, sameFile, screenshots }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

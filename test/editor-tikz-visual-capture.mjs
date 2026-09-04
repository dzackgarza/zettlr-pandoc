// Captures the TikZ editor scenes (issue #14): inline figures rendered by
// the REAL toolchain (pandoc + pdflatex + pdf2svg through the vendored
// filter), the in-place compile diagnostic, and the click-to-zoom lightbox
// reusing ImageViewer.
//
// Usage: node test/editor-tikz-visual-capture.mjs <outputDirectory>
//
// Expects <outputDirectory>/tikz-visual-bundle.js (esbuild bundle of
// test/editor-tikz-visual-entry.ts). The harness computes render results in
// this driver process through the real service and injects them into the
// page, so the page never needs the IPC transport while the render output is
// fully real.

import path from 'node:path'
import { register } from 'tsx/esm/api'
import { openScene, outputDirectory } from './visual/scene.mjs'

const here = import.meta.dirname
const unregisterTsx = register()

async function computeResponses () {
  const { renderTikz } = await import('../source/app/util/tikz-render.ts')
  const { SCENE_DOC } = await import('./editor-tikz-scene-doc.ts')

  // The same block shapes the widget will request: raw paragraphs delimited
  // by blank lines that begin with \begin{tikzcd}/\begin{tikzpicture}.
  const rawBlocks = SCENE_DOC.split('\n\n').filter(block => /^\\begin\{(tikzcd|tikzpicture)\}/.test(block))
  if (rawBlocks.length !== 3) {
    throw new Error(`expected 3 raw tikz blocks in the scene doc, found ${rawBlocks.length}`)
  }

  // The environment renders run under is an input to renderTikz, not
  // something it reads for itself; the harness states the one it is asking
  // for.
  const config = {
    tikzAssetDir: path.join(here, '../static/tikz'),
    cacheDir: path.join(outputDirectory, 'tikz-cache'),
    env: process.env
  }
  const responses = {}
  for (const source of rawBlocks) {
    // The scene document is not a file on disk, which the request models the
    // same way the editor configuration does: the empty path.
    const result = await renderTikz({ source, kind: 'raw', docPath: '' }, config)
    // Keyed as the page seam looks requests up: kind, NUL, source.
    responses[`raw\0${source}`] = result
  }
  const failures = Object.values(responses).filter(result => !result.ok)
  // Exactly the deliberately broken figure may fail, and it must carry the
  // mapped diagnostic — otherwise the toolchain itself is broken.
  if (failures.length !== 1 || failures[0].kind !== 'compile-error' || failures[0].errors.length === 0) {
    throw new Error(`unexpected render outcomes: ${JSON.stringify(Object.values(responses).map(r => r.ok ? 'ok' : r.kind))}`)
  }
  return responses
}

/**
 * Clicks the first rendered figure the way a reader does and waits for the
 * overlay. Returns the SVG file that figure carries, so the caller can hold
 * the viewer to displaying that figure.
 */
async function openLightbox (page) {
  const clicked = await page.evaluate(() => {
    const figure = document.querySelector('.tikz-figure[data-tikz-svg-path]')
    figure.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return figure.dataset.tikzSvgPath
  })
  // Wait for the figure to have been fetched and decoded, not merely for the
  // element to exist: a screenshot taken between those two moments shows an
  // empty viewer and says nothing about whether the overlay works.
  await page.waitForFunction(() => {
    const image = document.querySelector('.tikz-lightbox img')
    return image !== null && image.complete && image.naturalWidth > 0
  }, undefined, { timeout: 10000 })
  return clicked
}

async function capture (view, responses, spec) {
  const background = spec.dark ? '#2b2b2c' : '#ffffff'
  const foreground = spec.dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 920px; margin: 0 auto; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-scene="${spec.scene}" data-dark="${spec.dark}">
    <main id="editor"></main>
    <script>
      // ImageViewer reads process.platform through the renderer path
      // polyfill; the app's webpack runtime provides it, the harness page
      // must too.
      window.process = { platform: 'linux', env: {} }
      window.__tikzResponses = ${JSON.stringify(responses).replace(/</g, '\\u003c')}
    </script>
    <script src="./tikz-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)
  await view.page.locator('.tikz-figure svg').first().waitFor()

  const diagnostics = await view.page.evaluate(() => ({
    figures: document.querySelectorAll('.tikz-figure').length,
    svgs: document.querySelectorAll('.tikz-figure svg').length,
    errorText: document.querySelector('.tikz-error')?.textContent ?? null,
    rawVisible: (document.body.textContent ?? '').includes('\\begin{tikzcd}\nA \\arrow[r, "f"]')
  }))
  console.log(spec.name, JSON.stringify(diagnostics))
  if (diagnostics.svgs < 2) {
    throw new Error(`${spec.name}: expected two rendered figures`)
  }
  if (diagnostics.errorText === null || !diagnostics.errorText.includes('thisMacroDoesNotExist')) {
    throw new Error(`${spec.name}: the compile diagnostic must cite the offending source`)
  }
  await view.capture(spec.name)

  if (spec.lightbox !== true) {
    return
  }
  const clickedFigure = await openLightbox(view.page)
  const lightbox = await view.page.evaluate(() => ({
    open: document.querySelector('.tikz-lightbox') !== null,
    viewer: document.querySelector('.tikz-lightbox .image-viewer-container') !== null,
    imgSrc: document.querySelector('.tikz-lightbox img')?.getAttribute('src') ?? null
  }))
  console.log(`${spec.name}-lightbox`, JSON.stringify(lightbox))
  if (!lightbox.open || !lightbox.viewer || lightbox.imgSrc === null) {
    throw new Error(`${spec.name}: lightbox did not open over ImageViewer`)
  }
  // The viewer must be displaying the figure that was clicked. Resolved the
  // way the safe-file handler below resolves it, the src is the file the
  // clicked widget carries; an overlay handed anything else — a document
  // assembled around a path that was never supplied, say — cannot produce it.
  const shown = decodeURIComponent(lightbox.imgSrc.replace('safe-file://', ''))
  if (shown !== clickedFigure) {
    throw new Error(`${spec.name}: the viewer shows ${shown}, not the clicked figure ${clickedFigure}`)
  }
  await view.capture(`${spec.name}-lightbox`)

  // Both dismissals the overlay promises, each from a freshly opened
  // lightbox: clicking the backdrop, and Escape.
  await view.page.evaluate(() => {
    document.querySelector('.tikz-lightbox').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await view.page.locator('.tikz-lightbox').waitFor({ state: 'detached' })

  await openLightbox(view.page)
  await view.page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await view.page.locator('.tikz-lightbox').waitFor({ state: 'detached' })
}

const scenes = [
  { name: 'tikz-light', scene: 'main', dark: false, width: 1200, height: 1000, lightbox: true },
  { name: 'tikz-dark', scene: 'main', dark: true, width: 1200, height: 1000 }
]

const responses = await computeResponses()
unregisterTsx()

const view = await openScene({ width: 1200, height: 1000 })
// The app serves local images through its safe-file scheme (makeValidUri);
// the harness provides the same mapping in the Electron main process so the
// lightbox image loads.
await view.electronApp.evaluate(({ protocol, net }) => {
  protocol.handle('safe-file', request => {
    const filePath = decodeURIComponent(request.url.replace('safe-file://', ''))
    return net.fetch(`file://${encodeURI(filePath)}`)
  })
})
for (const spec of scenes) {
  await capture(view, responses, spec)
}
await view.close()

// Captures the TikZ editor scenes (issue #14) in isolated offscreen Electron:
// inline figures rendered by the REAL toolchain (pandoc + pdflatex + pdf2svg
// through the vendored filter), the in-place compile diagnostic, and the
// click-to-zoom lightbox reusing ImageViewer.
//
// Usage: xvfb-run -a electron test/editor-tikz-visual-capture.cjs <outputDirectory>
//
// Expects <outputDirectory>/tikz-visual-bundle.js (esbuild bundle of
// test/editor-tikz-visual-entry.ts). The harness computes render results in
// the main process through the real service (tsx-registered TypeScript
// require) and injects them into the page, so the page never needs the IPC
// transport while the render output is fully real.
'use strict'

require('tsx/cjs')

const { app, BrowserWindow, protocol, net } = require('electron')
const fs = require('fs/promises')
const path = require('path')
const { pathToFileURL: nodePathToFileURL } = require('url')

const outputDirectory = process.argv[process.argv.length - 1]

async function computeResponses () {
  const { renderTikz } = require('../source/app/util/tikz-render.ts')
  const { SCENE_DOC } = require('./editor-tikz-scene-doc.ts')

  // The same block shapes the widget will request: raw paragraphs delimited
  // by blank lines that begin with \begin{tikzcd}/\begin{tikzpicture}.
  const rawBlocks = SCENE_DOC.split('\n\n').filter(block => /^\\begin\{(tikzcd|tikzpicture)\}/.test(block))
  if (rawBlocks.length !== 3) {
    throw new Error(`expected 3 raw tikz blocks in the scene doc, found ${rawBlocks.length}`)
  }

  const cacheDir = path.join(outputDirectory, 'tikz-cache')
  const config = { tikzAssetDir: path.join(__dirname, '../static/tikz'), cacheDir }
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

async function capture (window, responses, scene) {
  const background = scene.dark ? '#2b2b2c' : '#ffffff'
  const foreground = scene.dark ? '#e5e7eb' : '#222222'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 920px; margin: 0 auto; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-scene="${scene.scene}" data-dark="${scene.dark}">
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
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 200))

  const diagnostics = await window.webContents.executeJavaScript(`(() => ({
    figures: document.querySelectorAll('.tikz-figure').length,
    svgs: document.querySelectorAll('.tikz-figure svg').length,
    errorText: document.querySelector('.tikz-error')?.textContent ?? null,
    rawVisible: (document.body.textContent ?? '').includes('\\\\begin{tikzcd}\\nA \\\\arrow[r, "f"]'),
  }))()`)
  console.log(scene.name, JSON.stringify(diagnostics))
  if (diagnostics.svgs < 2) {
    throw new Error(`${scene.name}: expected two rendered figures`)
  }
  if (diagnostics.errorText === null || !diagnostics.errorText.includes('thisMacroDoesNotExist')) {
    throw new Error(`${scene.name}: the compile diagnostic must cite the offending source`)
  }
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())

  if (scene.lightbox === true) {
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.tikz-figure[data-tikz-svg-path]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })()`)
    await new Promise(resolve => setTimeout(resolve, 400))
    const lightbox = await window.webContents.executeJavaScript(`(() => ({
      open: document.querySelector('.tikz-lightbox') !== null,
      viewer: document.querySelector('.tikz-lightbox .image-viewer-container') !== null,
      imgSrc: document.querySelector('.tikz-lightbox img')?.getAttribute('src') ?? null,
    }))()`)
    console.log(`${scene.name}-lightbox`, JSON.stringify(lightbox))
    if (!lightbox.open || !lightbox.viewer || lightbox.imgSrc === null) {
      throw new Error(`${scene.name}: lightbox did not open over ImageViewer`)
    }
    const lightboxImage = await window.webContents.capturePage()
    await fs.writeFile(path.join(outputDirectory, `${scene.name}-lightbox.png`), lightboxImage.toPNG())
    const dismissed = await window.webContents.executeJavaScript(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      for (let round = 0; round < 40; round++) {
        if (document.querySelector('.tikz-lightbox') === null) {
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)
    if (dismissed !== true) {
      throw new Error(`${scene.name}: Escape did not dismiss the lightbox`)
    }
  }
}

const scenes = [
  { name: 'tikz-light', scene: 'main', dark: false, width: 1200, height: 1000, lightbox: true },
  { name: 'tikz-dark', scene: 'main', dark: true, width: 1200, height: 1000 },
]

app.whenReady().then(async () => {
  // The app serves local images through its safe-file scheme (makeValidUri);
  // the harness provides the same mapping so the lightbox image loads.
  protocol.handle('safe-file', request => {
    const filePath = decodeURIComponent(request.url.replace('safe-file://', ''))
    return net.fetch(nodePathToFileURL(filePath).toString())
  })
  const responses = await computeResponses()
  const window = new BrowserWindow({
    width: 1200,
    height: 1000,
    show: false,
    webPreferences: { offscreen: true },
  })
  for (const scene of scenes) {
    await capture(window, responses, scene)
  }
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

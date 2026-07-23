// Captures the widget-indent scenes (issue #15) in isolated offscreen
// Electron and writes per-scene screenshots plus a diagnostics JSON that the
// editor-widget-indent spec asserts against.
//
// Usage: xvfb-run -a electron test/editor-widget-indent-visual-capture.cjs <outputDirectory>
//
// Expects <outputDirectory>/widget-indent-visual-bundle.js (esbuild browser
// bundle of test/editor-widget-indent-visual-entry.ts).
//
// The harness itself throws only on integrity failures — scenes that never
// arm the visual-indent trap or render no math widgets would make the
// diagnostics vacuously green. The overlap judgment lives in the spec so
// red/green is a test outcome, not a capture crash.
'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs/promises')
const path = require('path')

const outputDirectory = process.argv[process.argv.length - 1]
const scenes = [
  { name: 'list-math-light-wide', scene: 'list-math', dark: false, width: 1200, height: 800 },
  { name: 'list-math-dark-wide', scene: 'list-math', dark: true, width: 1200, height: 800 },
  { name: 'list-math-light-narrow', scene: 'list-math', dark: false, width: 520, height: 900 },
  { name: 'quote-div-light', scene: 'quote-div', dark: false, width: 1200, height: 800 },
  { name: 'table-mermaid-light', scene: 'table-mermaid', dark: false, width: 1200, height: 800 },
]

async function capture (window, scene) {
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
      // render-mermaid registers a config-provider listener and reads the
      // dark-mode flag at module evaluation; provision the preload seams the
      // renderer windows provide.
      window.ipc = { on: () => () => {}, invoke: async () => undefined, send: () => {}, sendSync: () => undefined }
      window.config = { get: key => key === 'darkMode' ? ${scene.dark} : undefined, set: () => {} }
      window.getCitationCallback = () => citations => citations.map(citation => citation.id).join('; ')
    </script>
    <script src="./widget-indent-visual-bundle.js"></script>
  </body></html>`
  const pagePath = path.join(outputDirectory, `${scene.name}.html`)
  await fs.writeFile(pagePath, page)
  window.setSize(scene.width, scene.height)
  await window.loadFile(pagePath)
  await window.webContents.executeJavaScript('window.captureReady')
  await new Promise(resolve => setTimeout(resolve, 150))
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'))
    const indentedLineCount = lines
      .filter(line => getComputedStyle(line).textIndent.startsWith('-')).length
    const widgets = Array.from(document.querySelectorAll('.preview-math')).map(host => {
      const container = host.querySelector('mjx-container')
      const inner = container === null ? null : container.querySelector('mjx-math')
      const line = host.closest('.cm-line')
      const containerRect = container === null ? null : container.getBoundingClientRect()
      const innerRect = inner === null ? null : inner.getBoundingClientRect()
      return {
        equation: host.dataset.equation,
        onIndentedLine: line !== null && getComputedStyle(line).textIndent.startsWith('-'),
        lineTextIndent: line === null ? null : getComputedStyle(line).textIndent,
        containerLeft: containerRect === null ? null : containerRect.left,
        innerLeft: innerRect === null ? null : innerRect.left,
        leftEscape: containerRect !== null && innerRect !== null
          ? Math.max(0, containerRect.left - innerRect.left)
          : null,
      }
    })
    const table = document.querySelector('.cm-content table')
    const mermaidSvg = document.querySelector('.cm-content svg')
    return {
      indentedLineCount,
      widgetCount: widgets.length,
      widgets,
      tableCellTexts: table === null
        ? null
        : Array.from(table.querySelectorAll('th, td')).map(cell => cell.textContent.trim()),
      tableMathContainers: table === null ? null : table.querySelectorAll('mjx-container').length,
      mermaidSvgChildCount: mermaidSvg === null ? null : mermaidSvg.childElementCount,
      // htmlLabels is false in the app's mermaid config, so labels are SVG
      // text nodes.
      mermaidNodeLabels: mermaidSvg === null
        ? null
        : Array.from(mermaidSvg.querySelectorAll('text')).map(label => label.textContent.trim()),
    }
  })()`)
  console.log(scene.name, JSON.stringify(diagnostics))
  if (scene.scene === 'table-mermaid') {
    if (diagnostics.tableCellTexts === null || diagnostics.mermaidSvgChildCount === null) {
      throw new Error(`${scene.name}: table or mermaid SVG missing — nothing under test`)
    }
  } else if (diagnostics.widgetCount === 0) {
    throw new Error(`${scene.name}: no math widget rendered — nothing under test`)
  }
  if (scene.scene === 'list-math') {
    // Only list lines arm the indent trap in this harness: the fork hides
    // blockquote marks, so quote lines measure a zero indent. The quote-div
    // scene is the regression surface for the escape removals instead.
    if (diagnostics.indentedLineCount === 0) {
      throw new Error(`${scene.name}: no line carries a visual indent — the trap is not armed`)
    }
    if (!diagnostics.widgets.some(widget => widget.onIndentedLine)) {
      throw new Error(`${scene.name}: no math widget sits on an indented line — nothing under test`)
    }
  }
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.json`), JSON.stringify(diagnostics, null, 2))
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { offscreen: true },
  })
  for (const scene of scenes) {
    await capture(window, scene)
  }
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})

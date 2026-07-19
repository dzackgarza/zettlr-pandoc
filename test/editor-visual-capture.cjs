// Captures screenshots of the fork's production MathJax renderer running in
// a real Chromium (Electron) page for the Task 6 visual suite.
//
// Usage: xvfb-run -a electron test/editor-visual-capture.cjs <workDirectory>
//
// Expects <workDirectory>/mathtex-bundle.cjs (esbuild browser bundle of
// source/common/util/mathtex-to-html.ts) and <workDirectory>/mathjax/ with
// the NewCM woff2 fonts. Each scene page executes initializeMathJax and
// mathJaxToElem exactly as renderer windows do.
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { readFileSync } = require('fs')

const workDirectory = process.argv[process.argv.length - 1]

// The app ships no macros; load the example fixture (the tex.macros format a
// user drops into their config dir) and inject it into the page.
const MACROS = readFileSync(path.join(__dirname, 'fixtures/mathjax-macros.json'), 'utf8')

const SCENES = [
  { name: 'light-wide', width: 1400, height: 1000, dark: false },
  { name: 'dark-wide', width: 1400, height: 1000, dark: true },
  { name: 'light-narrow', width: 480, height: 1100, dark: false }
]

const RENDER_SCRIPT = `(async () => {
  const mod = mathtex
  await mod.initializeMathJax(${MACROS})

  const content = document.getElementById('content')
  const section = (title) => {
    const h = document.createElement('h3')
    h.textContent = title
    content.appendChild(h)
    const div = document.createElement('div')
    content.appendChild(div)
    return div
  }

  mod.mathJaxToElem('\\\\RR \\\\quad \\\\qty{x + y} \\\\quad \\\\optpair{a}{b}', section('Configured macros (display)'), 'display')
  mod.mathJaxToElem('x^2 + y^2 = z^2', section('Inline math'), 'inline')
  mod.mathJaxToElem('p(x\\\\vert y) = \\\\frac{p(y \\\\vert x)p(x)}{p(y)}', section('Display fraction'), 'display')
  mod.mathJaxToElem('\\\\ce{Hg^2+ ->[I-] HgI2 ->[I-] [Hg^{II}I4]^2-}', section('mhchem'), 'inline')

  const tableSection = section('Table cell')
  const table = document.createElement('table')
  table.style.borderCollapse = 'collapse'
  const row = table.insertRow()
  for (const eq of ['\\\\qty{a + b}', '\\\\ce{CO2 + C -> 2 CO}']) {
    const cell = row.insertCell()
    cell.style.border = '1px solid #888'
    cell.style.padding = '0.5rem'
    mod.mathJaxToElem(eq, cell, 'inline')
  }
  tableSection.appendChild(table)

  const longSection = section('Long display equation (overflow check)')
  mod.mathJaxToElem('a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} + a_{11} + a_{12} + a_{13} + a_{14} + a_{15} + a_{16} + a_{17} + a_{18} = \\\\sum_{i=1}^{18} a_i', longSection, 'display')

  await document.fonts.ready
  return document.querySelectorAll('mjx-container').length
})()`

async function captureScene (win, scene) {
  const colors = scene.dark ? 'background:#1a1a1a;color:#ddd;' : 'background:#ffffff;color:#333;'
  // The fork's main.css mjx-container rules, inlined for the harness page.
  const forkCss = 'mjx-container { vertical-align: middle; } mjx-container[display="true"] { overflow-x: auto; overflow-y: hidden; }'
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${forkCss}</style></head>` +
    `<body style="margin:2rem;font-family:sans-serif;${colors}"><main id="content"></main>` +
    '<script src="./mathtex-bundle.cjs"></script></body></html>'
  const pageFile = path.join(workDirectory, `${scene.name}.html`)
  await fs.writeFile(pageFile, page)

  win.setSize(scene.width, scene.height)
  await win.loadFile(pageFile)
  const count = await win.webContents.executeJavaScript(RENDER_SCRIPT)
  await new Promise(resolve => setTimeout(resolve, 400))
  const image = await win.webContents.capturePage()
  await fs.writeFile(path.join(workDirectory, `${scene.name}.png`), image.toPNG())
  console.log(`captured ${scene.name}.png with ${count} containers`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { offscreen: true } })
  for (const scene of SCENES) {
    await captureScene(win, scene)
  }
  win.close()
  app.quit()
})

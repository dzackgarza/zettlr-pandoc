// Captures the TikZ editor scenes (issue #14): inline figures rendered by
// the REAL toolchain (pandoc + pdflatex + pdf2svg through the shared
// filter), the in-place compile diagnostic, textbook-scale sizing, and the
// explicit-control expansion through the same Viewer.js instance used by the
// editing side pane.
//
// Usage: node test/editor-tikz-visual-capture.mjs <outputDirectory>
//
// Expects <outputDirectory>/tikz-visual-bundle.js (esbuild bundle of
// test/editor-tikz-visual-entry.ts). The harness computes render results in
// this driver process through the real service and injects them into the
// page, so the page never needs the IPC transport while the render output is
// fully real.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { TIKZ_DISPLAY_MATH_SCALE } from '../source/common/modules/markdown-editor/tikz-display-size.ts'
import { openScene, outputDirectory } from './visual/scene.mjs'
import {
  STACKS_TIKZ_REFERENCES,
  stacksReplicaDocument
} from './tikz-stacks-reference.ts'

const here = import.meta.dirname

async function computeResponses () {
  const { renderTikz } = await import('../source/app/util/tikz-render.ts')
  const {
    SCENE_DOC,
    TEXTBOOK_MEDIUM_SCENE_DOC,
    TEXTBOOK_SMALL_SCENE_DOC,
    TEXTBOOK_WIDE_SCENE_DOC
  } = await import('./editor-tikz-scene-doc.ts')

  // The same block shapes the widget will request: raw paragraphs delimited
  // by blank lines that begin with \begin{tikzcd}/\begin{tikzpicture}.
  const rawBlocks = [
    SCENE_DOC,
    TEXTBOOK_SMALL_SCENE_DOC,
    TEXTBOOK_MEDIUM_SCENE_DOC,
    TEXTBOOK_WIDE_SCENE_DOC,
    ...STACKS_TIKZ_REFERENCES.map(reference => stacksReplicaDocument(reference.tag))
  ]
    .flatMap(document => document.split('\n\n').filter(block => /^\\begin\{(tikzcd|tikzpicture)\}/.test(block)))
  const expectedRawBlocks = 13 + STACKS_TIKZ_REFERENCES.reduce((total, reference) => total + reference.diagrams.length, 0)
  if (rawBlocks.length !== expectedRawBlocks) {
    throw new Error(`expected ${expectedRawBlocks} raw tikz blocks across the scene docs, found ${rawBlocks.length}`)
  }

  // The environment renders run under is an input to renderTikz, not
  // something it reads for itself; the harness states the one it is asking
  // for.
  const config = {
    tikzAssetDir: path.join(here, '../static/tikz'),
    templatePath: path.join(here, '../static/tikz/templates/standalone-tikz.tex'),
    cacheDir: path.join(outputDirectory, 'tikz-cache'),
    env: process.env
  }
  const responses = {}
  for (const source of rawBlocks) {
    const language = /^\\begin\{tikzcd\}/.test(source) ? 'tikzcd' : 'tikz'
    // The scene document is not a file on disk, which the request models the
    // same way the editor configuration does: the empty path.
    const result = await renderTikz({ source, kind: 'raw', language, docPath: '' }, config)
    // Keyed as the page seam looks requests up: kind, language, source.
    responses[`raw\0${language}\0${source.trim()}`] = result
  }
  const failures = Object.values(responses).filter(result => !result.ok)
  // Exactly the deliberately broken figure may fail, and it must carry the
  // mapped diagnostic — otherwise the toolchain itself is broken.
  if (failures.length !== 1 || failures[0].kind !== 'compile-error' || failures[0].errors.length === 0) {
    throw new Error(`unexpected render outcomes: ${JSON.stringify(Object.values(responses).map(r => r.ok ? 'ok' : r.kind))}`)
  }
  return responses
}


async function capture (view, responses, spec) {
  const background = spec.dark ? '#2b2b2c' : '#ffffff'
  const foreground = spec.dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #workspace { display: flex; width: 100%; min-height: 760px; max-width: 1140px; margin: 0 auto; overflow: hidden; }
    #editor { flex: 1 1 auto; min-width: 0; max-width: 920px; margin: 0 auto; }
    #tikz-live-preview-host { display: none; flex: 0 0 42%; min-width: 300px; }
    /* Exact Stacks A/B scenes use the Stacks desktop text geometry measured by
       this same capture driver: 632.984px equation measure, 14px body type. */
    body[data-scene^="stacks-"] #workspace { max-width: 633px; }
    body[data-scene^="stacks-"] #editor { max-width: 633px; }
    body[data-scene^="stacks-"] .cm-content { font-size: 14px; }
    body[data-scene="live"] #editor { max-width: none; margin: 0; }
    body[data-scene="live"] #tikz-live-preview-host { display: block; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-scene="${spec.scene}" data-dark="${spec.dark}">
    <div id="workspace">
      <main id="editor"></main>
      <div id="tikz-live-preview-host"></div>
    </div>
    <script>
      // Renderer utilities read process.platform; the app preload provides it,
      // while this isolated capture page must provide the same small seam.
      window.process = { platform: 'linux', env: {} }
      window.__tikzResponses = ${JSON.stringify(responses).replace(/</g, '\\u003c')}
    </script>
    <script src="./tikz-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)
  if (spec.scene === 'live') {
    await view.page.locator('.tikz-live-preview-figure .viewer-canvas img').first().waitFor()
  } else {
    await view.page.locator('.tikz-figure svg').first().waitFor()
  }

  const diagnostics = await view.page.evaluate(displayMathScale => {
    const editorWidth = document.querySelector('#editor')?.getBoundingClientRect().width ?? 0
    const editorFontPx = Number.parseFloat(
      getComputedStyle(document.querySelector('.cm-content') ?? document.body).fontSize
    )
    const naturalWidth = svg => {
      const value = svg.getAttribute('width')?.trim() ?? ''
      const match = /^([0-9.]+)(pt|px)?$/i.exec(value)
      if (match === null) return null
      const number = Number(match[1])
      if (!Number.isFinite(number)) return null
      return match[2]?.toLowerCase() === 'pt' ? number * 96 / 72 : number
    }
    const figureMetrics = Array.from(document.querySelectorAll('.tikz-figure')).flatMap((figure, index) => {
      const svg = figure.querySelector('svg')
      if (!(svg instanceof SVGSVGElement)) return []
      const displayed = svg.getBoundingClientRect().width
      const natural = naturalWidth(svg)
      const texFontSizePt = Number(figure.dataset.tikzTexFontSizePt)
      const expectedScale = Number.isFinite(texFontSizePt) && texFontSizePt > 0
        ? editorFontPx / (texFontSizePt * 96 / 72) * displayMathScale
        : null
      return [{
        index,
        displayed: Number(displayed.toFixed(2)),
        natural: natural === null ? null : Number(natural.toFixed(2)),
        share: editorWidth === 0 ? null : Number((displayed / editorWidth).toFixed(3)),
        scale: natural === null || natural === 0 ? null : Number((displayed / natural).toFixed(3)),
        expectedScale: expectedScale === null ? null : Number(expectedScale.toFixed(3))
      }]
    })
    return {
      figures: document.querySelectorAll('.tikz-figure').length,
      svgs: document.querySelectorAll('.tikz-figure svg').length,
      livePreview: document.querySelector('.tikz-live-preview') !== null,
      liveViewer: document.querySelector('.tikz-live-preview-figure .zettlr-tikz-viewerjs') !== null,
      liveStatus: document.querySelector('.tikz-live-preview-status')?.textContent ?? null,
      editorWidth,
      editorFontPx,
      figureMetrics,
      errorText: document.querySelector('.tikz-error')?.textContent ?? null,
      sourceSyntax: {
        keywords: Array.from(document.querySelectorAll('.cm-keyword')).map(node => node.textContent ?? ''),
        strings: Array.from(document.querySelectorAll('.cm-string')).map(node => node.textContent ?? ''),
        types: Array.from(document.querySelectorAll('.cm-type-name')).map(node => node.textContent ?? '')
      },
      rawVisible: Array.from(document.querySelectorAll('.cm-line')).some(line =>
        (line.textContent ?? '').includes('\\begin{tikzcd}')
      )
    }
  }, TIKZ_DISPLAY_MATH_SCALE)
  console.log(spec.name, JSON.stringify(diagnostics))
  if (spec.scene.startsWith('textbook-')) {
    const expected = spec.scene === 'textbook-small' ? 4 : 3
    const wronglyScaled = diagnostics.figureMetrics.filter(metric =>
      metric.scale === null || metric.expectedScale === null ||
      Math.abs(metric.scale - metric.expectedScale) > 0.03
    )
    if (diagnostics.svgs !== expected || wronglyScaled.length > 0) {
      throw new Error(
        `${spec.name}: textbook sizing must apply exactly the TeX-point-to-editor-em typography scale; ` +
        `got ${JSON.stringify(diagnostics)}`
      )
    }

    await view.capture(spec.name)
    return
  }
  if (spec.scene.startsWith('stacks-')) {
    const reference = STACKS_TIKZ_REFERENCES.find(item => `stacks-${item.tag}` === spec.scene)
    if (reference === undefined) {
      throw new Error(`${spec.name}: no Stacks reference manifest entry for ${spec.scene}`)
    }
    if (diagnostics.svgs !== reference.diagrams.length) {
      throw new Error(
        `${spec.name}: expected ${reference.diagrams.length} Stacks replica diagrams, got ${diagnostics.svgs}`
      )
    }
    spec.localMetrics = diagnostics
    await view.capture(spec.name)
    for (let index = 0; index < reference.diagrams.length; index++) {
      await view.page.locator('.tikz-figure').nth(index).screenshot({
        path: path.join(outputDirectory, `${spec.name}-${reference.diagrams[index].id}.png`)
      })
    }
    return
  }
  if (spec.scene === 'live') {
    if (!diagnostics.livePreview || !diagnostics.liveViewer || !diagnostics.rawVisible) {
      throw new Error(`${spec.name}: expected ordinary CodeMirror source beside the shared Viewer.js preview`)
    }
    if (
      !diagnostics.sourceSyntax.keywords.some(text => text.includes('\\arrow')) ||
      !diagnostics.sourceSyntax.strings.some(text => text.includes('"f"')) ||
      !diagnostics.sourceSyntax.types.some(text => text === 'r')
    ) {
      throw new Error(
        `${spec.name}: active tikzcd source is visible but does not carry the rich syntax classes: ` +
        JSON.stringify(diagnostics.sourceSyntax)
      )
    }
    // Fullscreen belongs to the unified RHS pane. Promote the pane and prove
    // the exact Viewer.js node remains mounted; there is no Viewer.js modal or
    // second lightbox surface.
    const marked = await view.page.evaluate(() => {
      const viewer = document.querySelector('.tikz-live-preview-figure .zettlr-tikz-viewerjs')
      if (!(viewer instanceof HTMLElement)) return false
      viewer.dataset.visualIdentity = 'same-rhs-viewer'
      return true
    })
    if (!marked) {
      throw new Error(`${spec.name}: shared Viewer.js RHS surface is missing`)
    }
    await view.page.locator('.tikz-live-preview-expand').click()
    await view.page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') === true)
    const expandedIdentity = await view.page.locator('.tikz-live-preview-figure .zettlr-tikz-viewerjs').getAttribute('data-visual-identity')
    if (expandedIdentity !== 'same-rhs-viewer') {
      throw new Error(`${spec.name}: pane fullscreen replaced the Viewer.js instance`)
    }
    if (await view.page.locator('.zettlr-tikz-viewerjs.viewer-fixed').count() !== 0) {
      throw new Error(`${spec.name}: unified pane expansion must not enter Viewer.js modal mode`)
    }
    await view.page.locator('.tikz-live-preview-expand').click()
    await view.page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') !== true)
    await view.page.waitForFunction(() => {
      const canvas = document.querySelector('.tikz-live-preview-figure .viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return false
      const canvasRect = canvas.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      return Math.max(imageRect.width / canvasRect.width, imageRect.height / canvasRect.height) >= 0.8
    })
    await view.page.locator('.tikz-live-preview-refresh').click()
    await view.page.waitForFunction(() => window.__tikzRequests.some(request => request.cachePolicy === 'refresh'))
    const refresh = await view.page.evaluate(() => window.__tikzRequests.findLast(request => request.cachePolicy === 'refresh'))
    if (refresh?.cachePolicy !== 'refresh') {
      throw new Error(`${spec.name}: refresh control did not issue a cache-bypassing render request`)
    }
    await view.capture(spec.name)
    return
  }
  if (diagnostics.svgs < 2) {
    throw new Error(`${spec.name}: expected two rendered figures`)
  }
  if (diagnostics.errorText === null || !diagnostics.errorText.includes('thisMacroDoesNotExist')) {
    throw new Error(`${spec.name}: the compile diagnostic must cite the offending source`)
  }
  await view.capture(spec.name)


}

function normalizeMathSource (source) {
  return source.replace(/\s+/g, ' ').trim()
}

async function writeComparisonScreenshot (page, referenceImagePath, localImagePath, outputPath, caption) {
  const [referenceBytes, localBytes] = await Promise.all([
    readFile(referenceImagePath),
    readFile(localImagePath)
  ])
  const referenceSrc = `data:image/png;base64,${referenceBytes.toString('base64')}`
  const localSrc = `data:image/png;base64,${localBytes.toString('base64')}`
  await page.setViewportSize({ width: 1320, height: 700 })
  await page.setContent(`<!doctype html><html><head><style>
    html, body { margin: 0; background: white; color: #222; font: 16px sans-serif; }
    h1 { margin: 18px 24px 4px; font-size: 18px; font-weight: 600; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 16px 24px 24px; }
    figure { margin: 0; min-width: 0; }
    figcaption { margin-bottom: 8px; font-size: 14px; font-weight: 600; }
    img { display: block; width: 100%; height: auto; border: 1px solid #ddd; background: white; }
  </style></head><body>
    <h1>${caption}</h1>
    <div class="pair">
      <figure><figcaption>Stacks original</figcaption><img src="${referenceSrc}"></figure>
      <figure><figcaption>Zettlr TikZ replica</figcaption><img src="${localSrc}"></figure>
    </div>
  </body></html>`)
  await page.screenshot({ path: outputPath, fullPage: true })
}

async function captureStacksReferences (localScenes) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, colorScheme: 'light' })
  const report = []
  try {
    for (const reference of STACKS_TIKZ_REFERENCES) {
      const response = await fetch(reference.url)
      if (!response.ok) {
        throw new Error(`Stacks ${reference.tag}: ${reference.url} returned HTTP ${response.status}`)
      }
      const source = normalizeMathSource(await response.text())
      for (const diagram of reference.diagrams) {
        if (!source.includes(normalizeMathSource(diagram.xymatrix))) {
          throw new Error(
            `Stacks ${reference.tag}/${diagram.id}: the live page no longer contains the recorded xymatrix source; ` +
            'refresh test/tikz-stacks-reference.ts from the authoritative tag page before changing sizing.'
          )
        }
      }

      await page.setViewportSize({ width: 1536, height: 1024 })
      await page.goto(reference.url, { waitUntil: 'networkidle', timeout: 60_000 })
      await page.waitForFunction(
        indexes => indexes.every(index => document.querySelectorAll('#tag .equation')[index]?.querySelector('svg') !== null),
        reference.diagrams.map(diagram => diagram.equationIndex),
        { timeout: 30_000 }
      )

      const referenceMetrics = await page.evaluate(diagrams => {
        const bodyFontPx = Number.parseFloat(getComputedStyle(document.querySelector('#tag') ?? document.body).fontSize)
        const columnWidth = document.querySelector('#tag .equation')?.getBoundingClientRect().width ?? 0
        return {
          bodyFontPx,
          columnWidth,
          diagrams: diagrams.map(diagram => {
            const equation = document.querySelectorAll('#tag .equation')[diagram.equationIndex]
            const svg = equation?.querySelector('svg')
            if (!(svg instanceof SVGSVGElement)) {
              throw new Error(`Stacks equation ${diagram.equationIndex} has no rendered SVG`)
            }
            const rect = svg.getBoundingClientRect()
            return {
              id: diagram.id,
              widthPx: rect.width,
              heightPx: rect.height,
              widthEm: rect.width / bodyFontPx,
              share: columnWidth === 0 ? null : rect.width / columnWidth
            }
          })
        }
      }, reference.diagrams.map(({ id, equationIndex }) => ({ id, equationIndex })))

      const localScene = localScenes.find(scene => scene.scene === `stacks-${reference.tag}`)
      if (localScene?.localMetrics === undefined) {
        throw new Error(`Stacks ${reference.tag}: local Zettlr scene metrics were not captured`)
      }
      const comparisons = reference.diagrams.map((diagram, index) => {
        const original = referenceMetrics.diagrams[index]
        const local = localScene.localMetrics.figureMetrics[index]
        const localWidthEm = local.displayed / localScene.localMetrics.editorFontPx
        const ratio = localWidthEm / original.widthEm
        if (!(ratio >= 0.92 && ratio <= 1.10)) {
          throw new Error(
            `Stacks ${reference.tag}/${diagram.id}: Zettlr width/body-em ratio drifted from the original ` +
            `(Zettlr=${localWidthEm.toFixed(3)}em, Stacks=${original.widthEm.toFixed(3)}em, ratio=${ratio.toFixed(3)}).`
          )
        }
        return {
          id: diagram.id,
          stacksWidthPx: Number(original.widthPx.toFixed(2)),
          stacksBodyFontPx: referenceMetrics.bodyFontPx,
          stacksWidthEm: Number(original.widthEm.toFixed(3)),
          zettlrWidthPx: local.displayed,
          zettlrEditorFontPx: localScene.localMetrics.editorFontPx,
          zettlrWidthEm: Number(localWidthEm.toFixed(3)),
          normalizedRatio: Number(ratio.toFixed(3))
        }
      })

      const firstEquation = page.locator('#tag .equation').nth(reference.diagrams[0].equationIndex)
      await firstEquation.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(outputDirectory, `stacks-${reference.tag}-original-page.png`) })

      for (let index = 0; index < reference.diagrams.length; index++) {
        const diagram = reference.diagrams[index]
        const originalPath = path.join(outputDirectory, `stacks-${reference.tag}-${diagram.id}-original.png`)
        const localPath = path.join(outputDirectory, `zettlr-stacks-${reference.tag}-${diagram.id}.png`)
        await page.locator('#tag .equation').nth(diagram.equationIndex).screenshot({ path: originalPath })
        await writeComparisonScreenshot(
          page,
          originalPath,
          localPath,
          path.join(outputDirectory, `compare-stacks-${reference.tag}-${diagram.id}.png`),
          `Stacks ${reference.tag} — ${diagram.id}`
        )
        // writeComparisonScreenshot replaces the page; restore the Stacks tag
        // before the next equation crop.
        if (index + 1 < reference.diagrams.length) {
          await page.goto(reference.url, { waitUntil: 'networkidle', timeout: 60_000 })
          await page.waitForFunction(
            equationIndex => document.querySelectorAll('#tag .equation')[equationIndex]?.querySelector('svg') !== null,
            reference.diagrams[index + 1].equationIndex,
            { timeout: 30_000 }
          )
        }
      }

      report.push({
        tag: reference.tag,
        url: reference.url,
        title: reference.title,
        columnWidth: referenceMetrics.columnWidth,
        bodyFontPx: referenceMetrics.bodyFontPx,
        comparisons
      })
    }
  } finally {
    await browser.close()
  }
  await writeFile(
    path.join(outputDirectory, 'tikz-stacks-reference.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  )
}

const scenes = [
  { name: 'tikz-light', scene: 'main', dark: false, width: 1200, height: 1000 },
  { name: 'tikz-dark', scene: 'main', dark: true, width: 1200, height: 1000 },
  { name: 'tikz-textbook-small', scene: 'textbook-small', dark: false, width: 1400, height: 1050 },
  { name: 'tikz-textbook-medium', scene: 'textbook-medium', dark: false, width: 1400, height: 1100 },
  { name: 'tikz-textbook-wide', scene: 'textbook-wide', dark: false, width: 1400, height: 1150 },
  ...STACKS_TIKZ_REFERENCES.map(reference => ({
    name: `zettlr-stacks-${reference.tag}`,
    scene: `stacks-${reference.tag}`,
    dark: false,
    width: 1400,
    height: reference.tag === '01JO' ? 1250 : 900
  })),
  { name: 'tikz-live', scene: 'live', dark: false, width: 1400, height: 900 }
]

const responses = await computeResponses()

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
await captureStacksReferences(scenes)

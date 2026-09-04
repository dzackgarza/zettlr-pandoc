import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const contentLines = [
  'First target alpha.',
  'Second target omega.',
  'Third target gamma.',
  'Fourth target delta.'
]
const targets = [
  { kind: 'text', text: 'alpha' },
  { kind: 'text', text: 'omega' },
  { kind: 'text', text: 'gamma' },
  { kind: 'text', text: 'delta' },
  { kind: 'text', text: 'Before outside.' },
  { kind: 'text', text: 'Between outside.' },
  { kind: 'text', text: 'After outside target.' },
  { kind: 'label', text: 'Definition' },
  { kind: 'label', text: 'Warning' },
  ...contentLines.flatMap(text => [
    { kind: 'gutter', side: 'left', text },
    { kind: 'gutter', side: 'right', text }
  ])
]

const view = await openScene({
  width: 1100,
  height: 760,
  userData: path.join(outputDirectory, 'user-data'),
  args: ['--ozone-platform=x11', '--disable-gpu']
})

await view.open('pandoc-div-click.html', `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: #fff; color: #222; }
    body { padding: 24px; box-sizing: border-box; }
    #editor { max-width: 860px; margin: 0 auto; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
  </style></head><body><main id="editor"></main><script src="./pandoc-div-click-bundle.js"></script></body></html>`)
await view.page.evaluate(() => window.clickProbeReady)
await view.browserWindow.evaluate(window => {
  window.focus()
  window.webContents.focus()
})

async function probeTarget (targetSpec) {
  await view.page.evaluate(() => window.clickProbeReset())
  const target = await view.page.evaluate(spec => {
    if (spec.kind === 'gutter') return window.clickProbePanelGutterTarget(spec.text, spec.side)
    if (spec.kind === 'label') return window.clickProbeLabelTarget(spec.text)
    return window.clickProbeTarget(spec.text)
  }, targetSpec)

  await view.page.mouse.click(Math.round(target.x), Math.round(target.y))

  return {
    kind: targetSpec.kind,
    side: targetSpec.side,
    text: targetSpec.text,
    expectedFrom: target.expectedFrom,
    expectedTo: target.expectedTo,
    expectedAtCoords: target.expectedAtCoords,
    hitTag: target.hitTag,
    actual: await view.page.evaluate(() => window.clickProbeAnchor())
  }
}

const results = []
for (const targetSpec of targets) {
  results.push(await probeTarget(targetSpec))
}
process.stdout.write(`${JSON.stringify(results)}\n`)
await view.close()

import { openScene } from './visual/scene.mjs'

const scenes = [
  { name: 'review-diff-wide-light', dark: false, width: 1040, height: 720 },
  { name: 'review-diff-narrow-light', dark: false, width: 430, height: 760 },
  { name: 'review-diff-wide-dark', dark: true, width: 1040, height: 720 },
  { name: 'review-diff-narrow-dark', dark: true, width: 430, height: 760 }
]

async function capture (view, spec) {
  const background = spec.dark ? '#2b2b2c' : '#ffffff'
  const foreground = spec.dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 24px; box-sizing: border-box; }
    #editor { max-width: 820px; margin: 0 auto; border: 1px solid ${spec.dark ? '#505050' : '#d5d5d5'}; }
    .cm-editor { min-height: 620px; height: 620px; font-size: 16px; line-height: 1.45; }
    .cm-scroller { padding: 18px 18px 48px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body class="${spec.dark ? 'dark' : ''}" data-dark="${spec.dark}">
    <main id="editor"></main>
    <script>
      // The table editor's subviews import the normal renderer extension set,
      // whose dictionary/config hooks expect the preload seams available in a
      // real Zettlr window.
      window.ipc = { on: () => () => {}, invoke: async () => undefined, send: () => {}, sendSync: () => undefined }
      window.config = { get: () => undefined, set: () => {} }
      window.getCitationCallback = () => citations => citations.map(citation => citation.id).join('; ')
    </script>
    <script src="./review-diff-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)

  const diagnostics = await view.page.evaluate(() => window.reviewDiffVisualDiagnostics())
  console.log(spec.name, JSON.stringify(diagnostics))
  // Both chunks are LOCATED in the editor — a struck-through deletion and a
  // highlighted insertion each. The controls under them are the pane's and
  // are captured by the review e2e specs.
  if (diagnostics.chunks !== 3 || diagnostics.deletions !== 2 || diagnostics.insertions !== 2) {
    throw new Error(`${spec.name} did not render the two inline chunks plus the table-owned chunk: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.tableReviewIndicators !== 1 || diagnostics.tableReviewSuggestionCount !== '1') {
    throw new Error(`${spec.name} did not surface the review chunk hidden by the rendered table: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${spec.name} has horizontal editor overflow`)
  }

  if (spec.name === 'review-diff-wide-light') {
    const regression = await view.page.evaluate(() => window.reviewRendererRegression())
    for (const snapshot of regression) {
      if (snapshot.cmLines === 0 || snapshot.visibleRanges.length === 0) {
        throw new Error(`review renderer collapsed at ${snapshot.from}-${snapshot.to}: ${JSON.stringify(snapshot)}`)
      }
      if (snapshot.changed === 0 && snapshot.deleted === 0) {
        throw new Error(`review marks disappeared at ${snapshot.from}-${snapshot.to}: ${JSON.stringify(snapshot)}`)
      }
    }
    for (const snapshot of regression) {
      const selectionVisible = snapshot.visibleRanges.some(range =>
        snapshot.from >= range.from && snapshot.from <= range.to
      )
      if (!selectionVisible) {
        throw new Error(`review navigation left the selected range outside CodeMirror's visible ranges: ${JSON.stringify(snapshot)}`)
      }
      if (!(snapshot.contentHeight > 0)) {
        throw new Error(`review renderer produced an invalid content height: ${JSON.stringify(snapshot)}`)
      }
    }
  }

  await view.capture(spec.name)
}

const view = await openScene({ width: 1040, height: 720, args: ['--ozone-platform=x11', '--disable-gpu'] })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

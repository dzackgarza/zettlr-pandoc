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
    <main id="editor"></main><script src="./review-diff-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)

  const diagnostics = await view.page.evaluate(() => window.reviewDiffVisualDiagnostics())
  console.log(spec.name, JSON.stringify(diagnostics))
  // The M9 structural gate, executable: both chunks are LOCATED in the
  // editor — a struck-through deletion and a highlighted insertion each —
  // and nothing in the editor can adjudicate them (I4). Adjudication is the
  // annotations panel's, captured by annotations-sidebar-visual-capture.
  if (diagnostics.chunks !== 2 || diagnostics.deletions !== 2 || diagnostics.insertions !== 2) {
    throw new Error(`${spec.name} did not render two located chunks: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.buttons !== 0 || diagnostics.inputs !== 0 || diagnostics.panels !== 0) {
    throw new Error(`${spec.name} renders an adjudication control inside the editor: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${spec.name} has horizontal editor overflow`)
  }

  await view.capture(spec.name)
}

const view = await openScene({ width: 1040, height: 720, args: ['--ozone-platform=x11', '--disable-gpu'] })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

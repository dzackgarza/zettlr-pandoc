import { openScene } from './visual/scene.mjs'

// The four scenes M5 owns (plan section 10 names). M10 assembles the full
// twelve-scene `just capture-annotations`; these are scoped to what the
// editor alone renders — no panel, no thread, no button (invariant I4).
const scenes = [
  { scene: '02-multiple-open-annotations', expect: { marks: 3, markers: 3 } },
  { scene: '07-deleted-target-point', expect: { marks: 0, markers: 1 } },
  { scene: '08-orphaned-target-warning', expect: { marks: 0, markers: 1 } },
  { scene: '09-overlapping-annotations', expect: { marks: 2, markers: 1 } }
]

async function capture (view, { scene: name, expect }, dark) {
  const background = dark ? '#2b2b2c' : '#ffffff'
  const foreground = dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 24px; box-sizing: border-box; }
    #editor { max-width: 820px; margin: 0 auto; border: 1px solid ${dark ? '#505050' : '#d5d5d5'}; }
    .cm-editor { min-height: 460px; height: 460px; font-size: 16px; line-height: 1.5; }
    .cm-scroller { padding: 12px 18px 24px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-dark="${dark}" data-scene="${name}">
    <main id="editor"></main><script src="./editor-annotations-visual-bundle.js"></script>
  </body></html>`
  const variant = `${name}-${dark ? 'dark' : 'light'}`
  await view.open(`${variant}.html`, html)
  await view.page.evaluate(() => window.captureReady)

  const diagnostics = await view.page.evaluate(() => window.annotationsVisualDiagnostics())
  console.log(variant, JSON.stringify(diagnostics))
  if (diagnostics.marks !== expect.marks || diagnostics.markers !== expect.markers) {
    throw new Error(`${variant} rendered ${diagnostics.marks} marks / ${diagnostics.markers} markers, expected ${expect.marks} / ${expect.markers}`)
  }
  if (diagnostics.buttons !== 0) {
    throw new Error(`${variant} rendered ${diagnostics.buttons} button(s) — the editor must carry no adjudication content (I4)`)
  }
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${variant} has horizontal editor overflow`)
  }

  await view.capture(variant)
}

const view = await openScene({ width: 900, height: 560, args: ['--ozone-platform=x11', '--disable-gpu'] })
for (const entry of scenes) {
  await capture(view, entry, false)
  await capture(view, entry, true)
}
await view.close()

import { openScene } from './visual/scene.mjs'

const scenes = [
  { name: 'overview-light-wide', scene: 'overview', dark: false, width: 1400, height: 1050 },
  { name: 'overview-dark-wide', scene: 'overview', dark: true, width: 1400, height: 1050 },
  { name: 'overview-light-narrow', scene: 'overview', dark: false, width: 480, height: 1050 },
  { name: 'overview-dark-narrow', scene: 'overview', dark: true, width: 480, height: 1050 },
  { name: 'active-hybrid-preview', scene: 'active', dark: false, width: 1200, height: 700 },
  { name: 'active-citation-edit', scene: 'citation-edit', dark: false, width: 1200, height: 700 },
  { name: 'nested-light', scene: 'nested', dark: false, width: 1200, height: 800 },
  { name: 'nested-dark', scene: 'nested', dark: true, width: 1200, height: 800 }
]

async function capture (view, spec) {
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
    <main id="editor"></main><script src="./pandoc-div-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)

  const diagnostics = await view.page.evaluate(() => {
    const panel = document.querySelector('pandoc-div-wrapper')
    const content = document.querySelector('.cm-content')
    return {
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth,
      panelWhiteSpace: panel === null ? null : getComputedStyle(panel).whiteSpace
    }
  })
  console.log(spec.name, diagnostics)
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${spec.name} has horizontal editor overflow`)
  }
  await view.capture(spec.name)
}

const view = await openScene({ width: 1400, height: 1050 })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

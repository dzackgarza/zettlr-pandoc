import { openScene } from './visual/scene.mjs'

const scenes = [
  { name: 'quick-help-light-wide', dark: false, width: 1180, height: 900 },
  { name: 'quick-help-dark-wide', dark: true, width: 1180, height: 900 },
  { name: 'quick-help-light-narrow', dark: false, width: 520, height: 900 },
  { name: 'quick-help-dark-narrow', dark: true, width: 520, height: 900 },
  { name: 'quick-help-light-wide-bottom', dark: false, width: 1180, height: 900, bottom: true },
  { name: 'quick-help-dark-narrow-bottom', dark: true, width: 520, height: 900, bottom: true }
]

async function capture (view, spec) {
  const background = spec.dark ? '#1d2024' : '#e9eaec'
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: ${background}; }
  </style></head><body class="${spec.dark ? 'dark' : ''}">
    <main id="app"></main><script src="./pandoc-quick-help-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)

  const readiness = await view.page.evaluate(() => ({
    type: typeof window.captureReady,
    body: document.body.innerHTML
  }))
  if (readiness.type !== 'object') {
    throw new Error(`${spec.name} did not initialize its capture entry: ${JSON.stringify(readiness)}`)
  }
  await view.page.evaluate(() => window.captureReady)

  const diagnostics = await view.page.evaluate(() => {
    const dialog = document.querySelector('.pandoc-quick-help')
    return {
      dialogClientWidth: dialog?.clientWidth,
      dialogScrollWidth: dialog?.scrollWidth,
      dialogClientHeight: dialog?.clientHeight,
      dialogScrollHeight: dialog?.scrollHeight,
      hasCloseButton: document.querySelector('button.close') !== null,
      objectRows: document.querySelectorAll('.crossref-row:not(.crossref-header)').length
    }
  })
  console.log(spec.name, diagnostics)
  if (diagnostics.dialogScrollWidth > diagnostics.dialogClientWidth + 1) {
    throw new Error(`${spec.name} has horizontal dialog overflow`)
  }
  // Five crossref families since issue #1 added lst (the same five-family
  // contract test/pandoc-quick-help.spec.ts pins).
  if (!diagnostics.hasCloseButton || diagnostics.objectRows !== 5) {
    throw new Error(`${spec.name} is missing required quick-reference controls or content`)
  }
  if (spec.bottom === true) {
    await view.page.evaluate(() => {
      const dialog = document.querySelector('.pandoc-quick-help')
      if (dialog !== null) dialog.scrollTop = dialog.scrollHeight
    })
    await view.page.waitForFunction(() => {
      const dialog = document.querySelector('.pandoc-quick-help')
      return dialog !== null && dialog.scrollTop > 0
    })
  }
  await view.capture(spec.name)
}

const view = await openScene({ width: 1180, height: 900 })
view.page.on('console', message => console.log('[renderer]', message.text()))
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

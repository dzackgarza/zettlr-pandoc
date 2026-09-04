import { openScene } from './visual/scene.mjs'

const scenes = [
  { name: 'chips-occurrences-light', scene: 'occurrences', dark: false, width: 1200, height: 800 },
  { name: 'chips-occurrences-dark', scene: 'occurrences', dark: true, width: 1200, height: 800 },
  { name: 'chips-definitions-light', scene: 'definitions', dark: false, width: 1200, height: 900 },
  { name: 'chips-definitions-dark', scene: 'definitions', dark: true, width: 1200, height: 900 },
  // The resolution-states scene (ledger C4): duplicate and missing keys stay
  // raw while resolved keys — including the one resolving into ProjectB with
  // projectRoots fed — render chips.
  { name: 'chips-states-light', scene: 'states', dark: false, width: 1200, height: 800 },
  { name: 'chips-states-dark', scene: 'states', dark: true, width: 1200, height: 800 }
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
    /* Minimal stand-in for the app stylesheet's code-block framing, so hidden
       fence lines read as a code region instead of blank lines. */
    .code { background: ${spec.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'}; font-family: monospace; }
  </style></head><body data-scene="${spec.scene}" data-dark="${spec.dark}">
    <main id="editor"></main><script src="./reference-chips-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)

  const diagnostics = await view.page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    return {
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth,
      chips: document.querySelectorAll('.reference-chip').length,
      labelBadges: document.querySelectorAll('.reference-definition-badge').length,
      countBadges: document.querySelectorAll('.reference-count-badge').length,
      positionedGroups: document.querySelectorAll('.reference-badge-group.positioned').length,
      rawMixed: document.body.textContent.includes('[@thm:torelli; @Ols04, Lem. 7.1]'),
      chipKeys: Array.from(document.querySelectorAll('.reference-chip')).map(chip => chip.getAttribute('data-reference-key')),
      rawDuplicateVisible: document.body.textContent.includes('@thm:torelli'),
      rawMissingVisible: document.body.textContent.includes('@fig:missing')
    }
  })
  console.log(spec.name, diagnostics)
  if (diagnostics.contentScrollWidth > diagnostics.contentClientWidth + 1) {
    throw new Error(`${spec.name} has horizontal editor overflow`)
  }
  if (spec.scene === 'occurrences' && diagnostics.chips === 0) {
    throw new Error(`${spec.name} rendered no reference chips`)
  }
  if (spec.scene === 'occurrences' && !diagnostics.rawMixed) {
    throw new Error(`${spec.name} did not keep the mixed cluster raw`)
  }
  if (spec.scene === 'definitions' && (diagnostics.countBadges === 0 || diagnostics.positionedGroups === 0)) {
    throw new Error(`${spec.name} rendered no positioned definition badges`)
  }
  if (spec.scene === 'states') {
    // Resolved keys render chips — including the ProjectB-resolved key —
    // while the duplicate and missing keys stay raw (no chip, authored
    // token visible).
    if (!diagnostics.chipKeys.includes('eq:intersection-form') ||
        !diagnostics.chipKeys.includes('lem:halphen-degeneration')) {
      throw new Error(`${spec.name} did not render the resolved chips: ${JSON.stringify(diagnostics.chipKeys)}`)
    }
    if (diagnostics.chipKeys.includes('thm:torelli')) {
      throw new Error(`${spec.name} rendered a chip for the duplicate key`)
    }
    if (!diagnostics.rawDuplicateVisible || !diagnostics.rawMissingVisible) {
      throw new Error(`${spec.name} does not show the raw duplicate/missing tokens`)
    }
  }
  await view.capture(spec.name)
}

const view = await openScene({ width: 1200, height: 900 })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

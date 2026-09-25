// Captures the production combined `@` completion surface (issue #1,
// ledger C4): the open popup listing citation entries and typed label
// entries together, one frame with a label option's info panel (the
// quick-help link), and one frame with the disabled another-Project entry
// selected — whose inert apply the driver also proves against the real
// document. Follows the editor-reference-chips-visual-capture.mjs pattern.

import { openScene } from './visual/scene.mjs'

// 1280 wide with a left-anchored editor: the popup needs more than 400px of
// free space beside it, or CodeMirror positions the selected option's info
// panel in "narrow" mode OVER the option list.
const scenes = [
  { name: 'reference-completion-combined-light', dark: false, width: 1280, height: 800 },
  { name: 'reference-completion-combined-dark', dark: true, width: 1280, height: 800 },
  { name: 'reference-completion-match-dark', dark: true, width: 1280, height: 800, query: 'th' },
  { name: 'reference-completion-label-info-light', dark: false, width: 1280, height: 800, select: 'thm:torelli' },
  { name: 'reference-completion-outside-project-light', dark: false, width: 1280, height: 800, select: 'lem:kodaira:embedding', proveInert: true }
]

// Citations precede label entries (the delegation contract); label entries
// follow in workspace document order.
const REQUIRED_LABELS = [
  'Ols04', 'Kod63', 'BHPV04',
  'thm:torelli', 'eq:intersection-form', 'tbl:coble-lattices', 'lem:kodaira:embedding'
]

async function capture (view, spec) {
  const background = spec.dark ? '#2b2b2c' : '#ffffff'
  const foreground = spec.dark ? '#e5e7eb' : '#222222'
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./reference-completion-visual-bundle.css"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 700px; margin: 0; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body class="${spec.dark ? 'dark' : ''}" data-dark="${spec.dark}">
    <main id="editor"></main><script src="./reference-completion-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html, spec.query === undefined ? {} : { query: spec.query })
  await view.page.evaluate(() => window.captureReady)

  const labels = await view.page.evaluate(() => window.completionProbeOptionLabels())
  if (spec.query === undefined) {
    const missingLabels = REQUIRED_LABELS.filter(label => !labels.includes(label))
    if (missingLabels.length > 0) {
      throw new Error(`${spec.name} omitted required citation/reference options ${JSON.stringify(missingLabels)} from ${JSON.stringify(labels)}`)
    }
  } else if (!labels.includes('thm:torelli')) {
    throw new Error(`${spec.name} did not retain the matching theorem option: ${JSON.stringify(labels)}`)
  }

  if (spec.select !== undefined) {
    const selection = await view.page.evaluate(label => window.completionProbeSelect(label), spec.select)
    if (selection.selected !== true) {
      throw new Error(`${spec.name} could not select the ${spec.select} option; walked: ${JSON.stringify(selection.seen)}`)
    }
    // The selected label option's info panel (the US-06 quick-help link)
    // renders asynchronously beside the popup.
    await view.page.locator('.cm-completionInfo [data-open-help]').waitFor()
  }

  // The list and its async info tooltip are positioned in separate measure /
  // animation phases. Sample geometry only after both have had two frames to
  // settle; otherwise the dark scene can catch the info box at its transient
  // pre-docking coordinates even though CodeMirror moves it beside the list on
  // the next frame.
  await view.page.evaluate(async () => await new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))

  const diagnostics = await view.page.evaluate(() => {
    const tooltip = document.querySelector('.cm-tooltip-autocomplete')
    const options = Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li'))
    const details = Array.from(document.querySelectorAll('.cm-completionDetail')).map(detail => detail.textContent)
    const sources = Array.from(document.querySelectorAll('.zettlr-completion-source'))
    const sourceLefts = sources.map(source => source.getBoundingClientRect().left)
    const detailStyles = Array.from(document.querySelectorAll('.cm-completionDetail')).map(detail => getComputedStyle(detail).fontStyle)
    const matched = Array.from(document.querySelectorAll('.cm-completionMatchedText'))
    const matchStyles = matched.map(match => {
      const style = getComputedStyle(match)
      return { weight: style.fontWeight, decoration: style.textDecorationLine, color: style.color }
    })
    const labelColors = Array.from(document.querySelectorAll('.cm-completionLabel')).map(label => getComputedStyle(label).color)
    const info = document.querySelector('.cm-completionInfo')
    const tooltipRect = tooltip === null ? null : tooltip.getBoundingClientRect()
    const infoRect = info === null ? null : info.getBoundingClientRect()
    return {
      infoBesideList: tooltipRect !== null && infoRect !== null &&
        (infoRect.left >= tooltipRect.right - 2 || infoRect.right <= tooltipRect.left + 2),
      hasTooltip: tooltip !== null,
      renderedOptions: options.length,
      tooltipWidth: tooltipRect?.width ?? 0,
      gridRows: options.filter(option => getComputedStyle(option).display === 'grid').length,
      sourceLabels: sources.map(source => source.textContent),
      sourceLeftSpread: sourceLefts.length === 0 ? null : Math.max(...sourceLefts) - Math.min(...sourceLefts),
      sourceIcons: document.querySelectorAll('.zettlr-completion-icon cds-icon').length,
      detailStyles,
      matchedCount: matched.length,
      matchStyles,
      labelColors,
      selectedLabel: options.find(option => option.getAttribute('aria-selected') === 'true')?.querySelector('.cm-completionLabel')?.textContent ?? null,
      details,
      infoText: info === null ? null : info.textContent,
      infoHasHelpLink: document.querySelector('.cm-completionInfo [data-open-help]') !== null
    }
  })
  console.log(spec.name, JSON.stringify(diagnostics))

  if (!diagnostics.hasTooltip || diagnostics.renderedOptions < (spec.query === undefined ? REQUIRED_LABELS.length : 1)) {
    throw new Error(`${spec.name} did not render the required combined option list`)
  }
  if (diagnostics.tooltipWidth < 575 || diagnostics.gridRows !== diagnostics.renderedOptions) {
    throw new Error(`${spec.name} did not use the wide tabular completion layout: ${JSON.stringify(diagnostics)}`)
  }
  if (
    (spec.query === undefined && (!diagnostics.sourceLabels.includes('[Cite]') || !diagnostics.sourceLabels.includes('[Ref]'))) ||
    (spec.query !== undefined && !diagnostics.sourceLabels.includes('[Ref]')) ||
    !diagnostics.sourceLabels.every(label => /^\[[^\]]+\]$/u.test(label ?? ''))
  ) {
    throw new Error(`${spec.name} has missing or malformed completion source labels: ${JSON.stringify(diagnostics.sourceLabels)}`)
  }
  if (diagnostics.sourceLeftSpread === null || diagnostics.sourceLeftSpread > 1 || diagnostics.sourceIcons !== diagnostics.renderedOptions) {
    throw new Error(`${spec.name} did not align its source/icon columns: ${JSON.stringify(diagnostics)}`)
  }
  if (diagnostics.detailStyles.some(style => style !== 'normal')) {
    throw new Error(`${spec.name} renders completion detail in italics: ${JSON.stringify(diagnostics.detailStyles)}`)
  }
  if (spec.query === undefined && (!diagnostics.details.includes('Theorem — Torelli for Enriques') ||
      !diagnostics.details.includes('Equation') ||
      !diagnostics.details.includes('Lemma — Kodaira embedding for Halphen pencils'))) {
    throw new Error(`${spec.name} is missing the Type — title label details: ${JSON.stringify(diagnostics.details)}`)
  }
  if (spec.query !== undefined) {
    if (diagnostics.matchedCount === 0 || diagnostics.matchStyles.some(style => style.decoration !== 'none')) {
      throw new Error(`${spec.name} did not use undecorated native match highlights: ${JSON.stringify(diagnostics.matchStyles)}`)
    }
    if (diagnostics.matchStyles.every(style => diagnostics.labelColors.includes(style.color))) {
      throw new Error(`${spec.name} did not visually distinguish matched text from muted labels: ${JSON.stringify(diagnostics)}`)
    }
  }
  if (spec.select !== undefined && diagnostics.selectedLabel !== spec.select) {
    throw new Error(`${spec.name} shows the wrong selected option: ${String(diagnostics.selectedLabel)}`)
  }
  if (diagnostics.infoText !== null && diagnostics.infoBesideList !== true) {
    throw new Error(`${spec.name}: the info panel overlaps the option list instead of docking beside it`)
  }

  await view.capture(spec.name)

  if (spec.proveInert === true) {
    // The disabled another-Project entry stays LISTED but its apply is
    // inert: accepting it changes nothing in the document.
    const before = await view.page.evaluate(() => window.completionProbeDoc())
    const after = await view.page.evaluate(() => window.completionProbeAccept())
    if (before !== after) {
      throw new Error(`${spec.name}: applying the disabled another-Project entry changed the document`)
    }
  }
}

const view = await openScene({ width: 1200, height: 800, args: ['--ozone-platform=x11', '--disable-gpu'] })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

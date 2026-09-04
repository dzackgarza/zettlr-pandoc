import { openScene } from './visual/scene.mjs'

const scenes = [
  // The resolved scenes capture BOTH hover frames (ledger C4): collapsed
  // (the excerpt genuinely clipped at its 10em bound) and expanded (a real
  // click on the production Expand toggle reveals the hidden content).
  { name: 'reference-hover-light', scene: 'resolved', dark: false, width: 1200, height: 800, expand: true },
  { name: 'reference-hover-dark', scene: 'resolved', dark: true, width: 1200, height: 800, expand: true },
  // The another-Project scenes hover the occurrence resolving into ProjectB
  // with projectRoots fed: the tooltip's Project-status row is the hover
  // surface of the outside-Project state (issue #1 Phase 7).
  { name: 'reference-hover-another-project-light', scene: 'another-project', dark: false, width: 1200, height: 800, expectStatus: 'another-project' },
  { name: 'reference-hover-another-project-dark', scene: 'another-project', dark: true, width: 1200, height: 800, expectStatus: 'another-project' }
]

async function readDiagnostics (page) {
  return await page.evaluate(() => {
    const tooltip = document.querySelector('.cm-tooltip.reference-hover-preview')
    const rect = tooltip === null ? null : tooltip.getBoundingClientRect()
    const excerpt = document.querySelector('[data-reference-excerpt]')
    const expand = document.querySelector('[data-reference-expand]')
    const status = document.querySelector('[data-reference-project-status]')
    return {
      hasTooltip: tooltip !== null,
      hasExcerpt: excerpt !== null,
      hasExpand: expand !== null,
      expandText: expand === null ? null : expand.textContent,
      excerptClipped: excerpt !== null && excerpt.scrollHeight > excerpt.clientHeight + 1,
      excerptClientHeight: excerpt === null ? null : excerpt.clientHeight,
      excerptExpanded: excerpt !== null && excerpt.classList.contains('expanded'),
      projectStatus: status === null ? null : status.getAttribute('data-reference-project-status'),
      projectStatusText: status === null ? null : status.textContent,
      rect: rect === null ? null : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }
  })
}

function assertOnScreen (name, diagnostics) {
  const { rect, viewport } = diagnostics
  if (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height) {
    throw new Error(`${name} tooltip is clipped by the window: ${JSON.stringify(rect)}`)
  }
}

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
  </style></head><body data-dark="${spec.dark}" data-scene="${spec.scene}">
    <main id="editor"></main><script src="./reference-hover-visual-bundle.js"></script>
  </body></html>`
  await view.setSize(spec.width, spec.height)
  await view.open(`${spec.name}.html`, html)
  await view.page.evaluate(() => window.captureReady)
  await view.page.locator('.cm-tooltip.reference-hover-preview').waitFor()

  const collapsed = await readDiagnostics(view.page)
  console.log(spec.name, JSON.stringify(collapsed))
  if (!collapsed.hasTooltip || !collapsed.hasExcerpt || !collapsed.hasExpand) {
    throw new Error(`${spec.name} did not present the complete hover tooltip`)
  }
  assertOnScreen(spec.name, collapsed)

  if (spec.expectStatus !== undefined) {
    if (collapsed.projectStatus !== spec.expectStatus) {
      throw new Error(`${spec.name} shows the wrong Project status: ${String(collapsed.projectStatus)}`)
    }
  } else if (collapsed.projectStatus !== null) {
    throw new Error(`${spec.name} fabricated a Project status without projectRoots`)
  }

  await view.capture(spec.name)

  if (spec.expand !== true) {
    return
  }
  // The collapsed excerpt must actually clip, or the expanded frame would
  // show nothing new.
  if (!collapsed.excerptClipped || collapsed.excerptExpanded) {
    throw new Error(`${spec.name}'s collapsed excerpt is not genuinely clipped`)
  }
  // Dispatched rather than driven with the mouse: this is a HOVER tooltip,
  // and moving the pointer across the editor to reach the toggle re-anchors
  // it, so the expanded frame would no longer show the hovered occurrence.
  await view.page.evaluate(() => { document.querySelector('[data-reference-expand]').click() })
  await view.page.locator('[data-reference-excerpt].expanded').waitFor()
  // The class lands before CodeMirror re-anchors the now-taller tooltip;
  // capturing in between shows it mid-reposition. Its top moving off the
  // collapsed anchor is the completion signal.
  await view.page.waitForFunction(
    collapsedTop => {
      const tooltip = document.querySelector('.cm-tooltip.reference-hover-preview')
      return tooltip !== null && tooltip.getBoundingClientRect().top !== collapsedTop
    },
    collapsed.rect.top
  )

  const expanded = await readDiagnostics(view.page)
  console.log(`${spec.name}-expanded`, JSON.stringify(expanded))
  if (!expanded.excerptExpanded || expanded.expandText !== 'Collapse') {
    throw new Error(`${spec.name}'s Expand toggle did not expand the excerpt`)
  }
  if (expanded.excerptClientHeight <= collapsed.excerptClientHeight) {
    throw new Error(`${spec.name}'s expanded excerpt did not grow`)
  }
  assertOnScreen(`${spec.name}-expanded`, expanded)
  await view.capture(spec.name.replace('reference-hover-', 'reference-hover-expanded-'))
}

const view = await openScene({ width: 1200, height: 800 })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()

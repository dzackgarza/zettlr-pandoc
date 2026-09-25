/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app TikZ live-preview journey
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Drives the real MainEditor/CodeMirror/TikZ IPC boundary:
 *                  entering a TikZ block opens the microlocal sidecar, a real
 *                  TeX error leaves the last-good SVG visible, correcting the
 *                  source recovers, and the explicit rerender completes.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { type EditorView } from '@codemirror/view'
import { type Browser, type Page } from 'playwright'
import {
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  requireInitialized,
  shutdown
} from './support/electron-app'

/** The production editor's content element; CodeMirror keeps its view on the element's tile. */
type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } }

/** A message the embedded Quiver host posts to Zettlr (vendor/quiver/src/zettlr-host.mjs). */
interface QuiverBridgeMessage {
  type: string
  sessionId?: string|null
  source?: string
  message?: string
}

const DOCUMENT = String.raw`# TikZ live integration

\begin{tikzcd}
A \arrow[r, "f"] & B
\end{tikzcd}

\begin{tikzpicture}[
  box/.style={rectangle, draw, minimum width=2.5cm, minimum height=0.8cm},
  dot/.style={circle, draw, minimum size=0.8cm}
]
\node[dot] (eta) at (0,0) {$\eta$};
\node[box] (A1) at (4,1) {$A_1$};
\draw[->] (eta.east) -- (A1.west);
\end{tikzpicture}
`

describe('TikZ microlocal live preview in the assembled app', function () {
  this.timeout(240_000)

  let appProcess: ChildProcess|undefined
  let browser: Browser|undefined
  let page: Page|undefined
  let fixtureRoot: string|undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []

  before(async function () {
    const fixture = await createFixture('zettlr-tikz-live-e2e-', {
      documentName: 'tikz-live.md',
      documentContents: DOCUMENT
    })
    fixtureRoot = fixture.root
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    page = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(page)
  })

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    assert.doesNotMatch(
      getOutput(),
      /(?:^|\n).*FATAL:|Uncaught exception/,
      'the assembled app must not terminate through a fatal/uncaught error'
    )
  })

  it('retains the last-good figure through a compile failure and recovers', async function () {
    assert.ok(page !== undefined, 'the main editor page must be attached')

    const entered = await page.evaluate(`(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      const pos = view.state.doc.toString().indexOf('A \\\\arrow') + 2
      if (pos < 2) return false
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
      return true
    })()`)
    assert.strictEqual(entered, true, 'the production CodeMirror view must expose the authored TikZ body')

    const preview = page.locator('.tikz-live-preview')
    await preview.waitFor({ state: 'visible', timeout: 20_000 })
    const tikzMode = preview.getByRole('button', { name: 'TikZ', exact: true })
    const quiverMode = preview.getByRole('button', { name: 'Quiver', exact: true })
    const visualMode = preview.getByRole('button', { name: 'Visual', exact: true })
    assert.strictEqual(await quiverMode.getAttribute('aria-pressed'), 'true', 'tikzcd defaults the unified RHS preview to Quiver')
    assert.strictEqual(await tikzMode.getAttribute('aria-pressed'), 'false')
    assert.strictEqual(await visualMode.isDisabled(), true, 'ordinary visual TikZ editing is never offered for tikzcd')
    const quiverFrame = page.frameLocator('.tikz-quiver-frame')
    await quiverFrame.locator('.vertex').first().waitFor({ state: 'visible', timeout: 20_000 })
    assert.ok(await quiverFrame.locator('.vertex').count() >= 2, 'the RHS Quiver preview imports the authored tikzcd diagram')
    assert.ok(
      (await page.locator('.cm-content').innerText()).includes('\\begin{tikzcd}'),
      'the ordinary CodeMirror source remains the editing surface beside Quiver'
    )

    // The same RHS pane can show the compiler-backed TikZ preview. Choosing it
    // starts the TeX renderer; Quiver is not accompanied by a hidden background
    // compile while it is the active/default mode.
    await tikzMode.click()
    await preview.locator('.tikz-live-preview-figure .viewer-canvas img').waitFor({ state: 'visible', timeout: 60_000 })
    await page.waitForFunction(
      () => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Up to date') === true,
      undefined,
      { timeout: 60_000 }
    )

    await page.waitForFunction(() => {
      const canvas = document.querySelector('.tikz-live-preview-figure .viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return false
      const canvasRect = canvas.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      return Math.max(imageRect.width / canvasRect.width, imageRect.height / canvasRect.height) >= 0.8
    }, undefined, { timeout: 20_000 })
    const initialFit = await page.evaluate(() => {
      const canvas = document.querySelector('.tikz-live-preview-figure .viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return null
      const canvasRect = canvas.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      return {
        widthShare: imageRect.width / canvasRect.width,
        heightShare: imageRect.height / canvasRect.height
      }
    }) as { widthShare: number, heightShare: number }|null
    assert.ok(
      initialFit !== null && Math.max(initialFit.widthShare, initialFit.heightShare) >= 0.8,
      `the dedicated viewer must default to a useful contain fit rather than the SVG's tiny intrinsic size: ${JSON.stringify(initialFit)}`
    )

    const inlineViewer = preview.locator('.tikz-live-preview-figure .zettlr-tikz-viewerjs')
    await inlineViewer.locator('.viewer-canvas').click({ position: { x: 8, y: 8 } })
    assert.strictEqual(
      await page.locator('.zettlr-tikz-viewerjs.viewer-fixed').count(),
      0,
      'the RHS canvas has no competing Viewer.js modal path'
    )
    assert.strictEqual(
      await inlineViewer.locator('.viewer-button').isVisible(),
      false,
      'Viewer.js does not expose a second visible fullscreen control inside the unified RHS pane'
    )

    // Fullscreen belongs to the pane, not to either preview backend. Mark the
    // Viewer.js node, promote the pane, and require the same viewer instance to
    // remain mounted while it refits to the larger canvas.
    await page.evaluate(() => {
      const viewer = document.querySelector('.tikz-live-preview-figure .zettlr-tikz-viewerjs')
      if (!(viewer instanceof HTMLElement)) throw new Error('inline Viewer.js surface missing')
      viewer.dataset.e2eViewerIdentity = 'editing-instance'
    })
    await preview.locator('.tikz-live-preview-expand').click()
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') === true)
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.tikz-live-preview.fullscreen .tikz-live-preview-figure .viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return false
      const canvasRect = canvas.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      return Math.max(imageRect.width / canvasRect.width, imageRect.height / canvasRect.height) >= 0.8
    }, undefined, { timeout: 20_000 })
    assert.strictEqual(
      await inlineViewer.getAttribute('data-e2e-viewer-identity'),
      'editing-instance',
      'fullscreen promotion preserves the exact RHS Viewer.js instance'
    )
    assert.strictEqual(await page.locator('.zettlr-tikz-viewerjs').count(), 1, 'fullscreen does not create a second viewer')
    assert.strictEqual(await inlineViewer.locator('input[type="number"]').count(), 0, 'the removed numeric zoom field remains absent')
    await preview.locator('.tikz-live-preview-expand').click()
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') !== true)

    // The mature viewer owns touch/pinch. Drive two real pointer identities
    // apart and require the displayed image to grow, which the old mouse-only
    // hand-written sidecar could not do.
    const pinch = await page.evaluate(`(async () => {
      const canvas = document.querySelector('.tikz-live-preview-figure .viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return null
      const before = image.getBoundingClientRect().width
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 280, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 280, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 120 }))
      await new Promise(resolve => setTimeout(resolve, 50))
      return { before, after: image.getBoundingClientRect().width }
    })()`) as { before: number, after: number }|null
    assert.ok(pinch !== null && pinch.after > pinch.before, `touch pinch must zoom the shared viewer: ${JSON.stringify(pinch)}`)

    // A successful source edit must replace only the SVG, not the viewer or
    // the user's viewport. Sample every painted frame while the real TeX render
    // runs so a transient shrink-to-natural-size/rezoom cycle is a failure too.
    const stableBefore = await page.evaluate(() => {
      const viewer = document.querySelector('.tikz-live-preview-figure .zettlr-tikz-viewerjs')
      const canvas = viewer?.querySelector('.viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(viewer instanceof HTMLElement) || !(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return null
      viewer.dataset.e2eStableEditIdentity = 'same-viewer-across-compile'
      const width = Number.parseFloat(image.style.width)
      const height = Number.parseFloat(image.style.height)
      const x = Number.parseFloat(image.style.marginLeft)
      const y = Number.parseFloat(image.style.marginTop)
      const canvasRect = canvas.getBoundingClientRect()
      const footer = viewer.querySelector('.viewer-footer')
      const footerHeight = footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0
      const contentHeight = Math.max(0, canvasRect.height - footerHeight)
      return {
        ratio: width / image.naturalWidth,
        centerOffsetX: x + width / 2 - canvasRect.width / 2,
        centerOffsetY: y + height / 2 - contentHeight / 2,
      }
    })
    assert.ok(stableBefore !== null && Number.isFinite(stableBefore.ratio), 'a stable zoomed viewer state must exist before editing')
    const previousSvgPath = await preview.locator('.tikz-live-preview-figure').getAttribute('data-svg-path')
    assert.ok(previousSvgPath !== null, 'the live viewer must name its current rendered SVG')

    const zoomSampler = await page.evaluateHandle(() => {
      const samples: number[] = []
      const sampler = {
        sampling: true,
        samples,
        // A method, not a named arrow: the test transpiler wraps named
        // functions in a helper the page does not define.
        tick (): void {
          const image = document.querySelector('.tikz-live-preview-figure .viewer-canvas img')
          if (image instanceof HTMLImageElement && image.naturalWidth > 0) {
            const width = Number.parseFloat(image.style.width)
            if (Number.isFinite(width)) sampler.samples.push(width / image.naturalWidth)
          }
          if (sampler.sampling) requestAnimationFrame(() => sampler.tick())
        }
      }
      requestAnimationFrame(() => sampler.tick())
      return sampler
    })

    const validEdit = await page.evaluate(`(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      const source = view.state.doc.toString()
      const at = source.indexOf('"f"') + 2
      if (at < 2) return false
      view.dispatch({ changes: { from: at, insert: '_1' }, selection: { anchor: at + 2 } })
      view.focus()
      return true
    })()`)
    assert.strictEqual(validEdit, true, 'the valid TikZ edit must land through CodeMirror')
    await preview.locator('.tikz-live-preview-spinner').waitFor({ state: 'visible', timeout: 20_000 })
    assert.ok(
      await preview.locator('.tikz-live-preview-figure .viewer-canvas img').isVisible(),
      'recompiling keeps the last-good figure visible behind the busy indicator'
    )
    assert.match(
      await preview.locator('.tikz-live-preview-status').innerText(),
      /Updating|Rendering/,
      'the spinner accompanies an explicit rendering status'
    )
    await page.waitForFunction(
      previous => document.querySelector('.tikz-live-preview-figure')?.getAttribute('data-svg-path') !== previous,
      previousSvgPath,
      { timeout: 60_000 }
    )
    await page.waitForFunction(
      () => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Up to date') === true,
      undefined,
      { timeout: 60_000 }
    )
    assert.strictEqual(
      await preview.locator('.tikz-live-preview-spinner').count(),
      0,
      'the busy indicator disappears as soon as the recompile finishes'
    )
    const stableAfter = await page.evaluate(sampler => {
      sampler.sampling = false
      const viewer = document.querySelector('.tikz-live-preview-figure .zettlr-tikz-viewerjs')
      const canvas = viewer?.querySelector('.viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(viewer instanceof HTMLElement) || !(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return null
      const width = Number.parseFloat(image.style.width)
      const height = Number.parseFloat(image.style.height)
      const x = Number.parseFloat(image.style.marginLeft)
      const y = Number.parseFloat(image.style.marginTop)
      const canvasRect = canvas.getBoundingClientRect()
      const footer = viewer.querySelector('.viewer-footer')
      const footerHeight = footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0
      const contentHeight = Math.max(0, canvasRect.height - footerHeight)
      return {
        identity: viewer.dataset.e2eStableEditIdentity,
        ratio: width / image.naturalWidth,
        centerOffsetX: x + width / 2 - canvasRect.width / 2,
        centerOffsetY: y + height / 2 - contentHeight / 2,
        samples: sampler.samples
      }
    }, zoomSampler)
    assert.ok(stableAfter !== null, 'the updated TikZ viewer must remain mounted')
    assert.strictEqual(stableAfter.identity, 'same-viewer-across-compile', 'a successful compile updates the existing Viewer.js instance')
    assert.ok(Math.abs(stableAfter.ratio - stableBefore.ratio) < 0.02, `zoom ratio survives a valid edit: before=${stableBefore.ratio}, after=${stableAfter.ratio}`)
    assert.ok(Math.abs(stableAfter.centerOffsetX - stableBefore.centerOffsetX) < 2, 'horizontal pan survives a valid edit')
    assert.ok(Math.abs(stableAfter.centerOffsetY - stableBefore.centerOffsetY) < 2, 'vertical pan survives a valid edit')
    assert.ok(stableAfter.samples.length >= 2, 'the update was observed across painted frames')
    assert.ok(
      stableAfter.samples.every(ratio => Math.abs(ratio - stableBefore.ratio) < Math.max(0.05, stableBefore.ratio * 0.08)),
      `no painted frame may shrink and rezoom during a source update: ${JSON.stringify(stableAfter.samples)}`
    )

    const inserted = String.raw` \thisMacroDoesNotExist`
    const edit = await page.evaluate(`(() => {
      const inserted = ${JSON.stringify(inserted)}
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return null
      const at = view.state.doc.toString().indexOf('& B') + 3
      if (at < 3) return null
      view.dispatch({
        changes: { from: at, insert: inserted },
        selection: { anchor: at + inserted.length }
      })
      view.focus()
      return { at, length: inserted.length }
    })()`) as { at: number, length: number }|null
    assert.ok(edit !== null, 'the invalid edit must land through the production CodeMirror view')

    await preview.locator('.tikz-live-preview-error').waitFor({ state: 'visible', timeout: 60_000 })
    assert.ok(
      await preview.locator('.tikz-live-preview-figure .viewer-canvas img').isVisible(),
      'the previous successful SVG remains visible while the current source is invalid'
    )
    assert.match(await preview.locator('.tikz-live-preview-status').innerText(), /Last good render/)
    assert.match(
      await preview.locator('.tikz-live-preview-error').innerText(),
      /Undefined control sequence|failed to compile/
    )

    await page.evaluate(`(() => {
      const at = ${edit.at}
      const length = ${edit.length}
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) throw new Error('CodeMirror view disappeared')
      view.dispatch({
        changes: { from: at, to: at + length, insert: '' },
        selection: { anchor: at }
      })
      view.focus()
    })()`)
    await page.waitForFunction(
      () => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Up to date') === true,
      undefined,
      { timeout: 60_000 }
    )
    assert.strictEqual(
      await preview.locator('.tikz-live-preview-error').count(),
      0,
      'the compile diagnostic clears after the corrected source renders'
    )

    await preview.locator('.tikz-live-preview-refresh').click()
    await page.waitForFunction(
      () => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Up to date') === true,
      undefined,
      { timeout: 60_000 }
    )

    // Leave source editing, then activate the rendered tikzcd. Every TikZ
    // widget now follows the same edit-first path; tikzcd differs only in the
    // RHS renderer that is selected after the source becomes active.
    await page.evaluate(`(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) throw new Error('CodeMirror view disappeared')
      view.dispatch({ selection: { anchor: 1 } })
      view.focus()
    })()`)
    await preview.waitFor({ state: 'detached', timeout: 20_000 })
    const inlineTikzCd = page.locator('.tikz-figure[data-tikz-language="tikzcd"]')
    await inlineTikzCd.locator('svg').waitFor({ state: 'visible', timeout: 60_000 })
    assert.strictEqual(await inlineTikzCd.locator('.tikz-expand-button').count(), 0, 'inline figures have no competing fullscreen control')
    await inlineTikzCd.locator('svg').click()
    await preview.waitFor({ state: 'visible', timeout: 20_000 })

    const rhsTikzMode = preview.getByRole('button', { name: 'TikZ', exact: true })
    const rhsQuiverMode = preview.getByRole('button', { name: 'Quiver', exact: true })
    assert.strictEqual(await rhsQuiverMode.getAttribute('aria-pressed'), 'true', 'rendered tikzcd activation defaults the RHS pane to Quiver')
    assert.strictEqual(await rhsQuiverMode.isEnabled(), true)
    assert.strictEqual(await rhsTikzMode.getAttribute('aria-pressed'), 'false')

    await quiverFrame.locator('.vertex').first().waitFor({ state: 'visible', timeout: 20_000 })
    assert.ok(await quiverFrame.locator('.vertex').count() >= 2, 'the local vendored Quiver frame imported the authored diagram')
    for (const webAction of [ 'save', 'autosave-on', 'dark-theme', 'about' ]) {
      assert.strictEqual(
        await quiverFrame.locator(`.toolbar .action[data-name="${webAction}"]`).count(),
        0,
        `embedded Quiver must not register its web-only ${webAction} action`
      )
    }
    assert.strictEqual(await quiverFrame.locator('.toolbar .action[data-name="undo"]').count(), 1, 'native Quiver undo remains available')
    assert.strictEqual(await quiverFrame.locator('.panel.global').isVisible(), false, 'web import/export/code panel is not exposed')
    assert.strictEqual(await quiverFrame.locator('.port').isVisible(), false, 'web import/export modal surface is not exposed')

    // Embedded Escape belongs to Quiver itself; it must not close the RHS pane.
    await quiverFrame.locator('body').click({ position: { x: 20, y: 20 } })
    await page.keyboard.press('Escape')
    assert.strictEqual(await preview.isVisible(), true, 'Escape in embedded Quiver does not close the RHS preview')
    assert.strictEqual(await preview.evaluate(element => element.classList.contains('fullscreen')), false)

    // The one pane-level expand control promotes whichever renderer is active.
    // Mark the iframe and prove fullscreen promotion/collapse preserves it.
    await page.evaluate(() => {
      const frame = document.querySelector('.tikz-quiver-frame')
      if (!(frame instanceof HTMLIFrameElement)) throw new Error('embedded Quiver frame missing')
      frame.dataset.e2eQuiverIdentity = 'same-quiver-frame'
    })
    await preview.locator('.tikz-live-preview-expand').click()
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') === true)
    assert.strictEqual(
      await page.locator('.tikz-quiver-frame').getAttribute('data-e2e-quiver-identity'),
      'same-quiver-frame',
      'fullscreen promotion keeps the exact embedded Quiver iframe'
    )
    assert.strictEqual(await page.locator('.tikz-quiver-frame').count(), 1, 'fullscreen Quiver does not create a second iframe')
    await quiverFrame.locator('body').click({ position: { x: 20, y: 20 } })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') !== true)
    assert.strictEqual(await preview.isVisible(), true, 'Escape collapses fullscreen Quiver back into the RHS pane instead of closing editing')
    assert.strictEqual(
      await page.locator('.tikz-quiver-frame').getAttribute('data-e2e-quiver-identity'),
      'same-quiver-frame',
      'fullscreen Escape preserves the same Quiver session/iframe'
    )

    await quiverFrame.locator('.toolbar .action[data-name="shortcuts"]').click()
    const shortcutPane = quiverFrame.locator('#keyboard-shortcuts-pane')
    await shortcutPane.waitFor({ state: 'visible', timeout: 10_000 })
    const shortcutText = await shortcutPane.innerText()
    assert.doesNotMatch(shortcutText, /Import from LaTeX|Export to LaTeX|Save diagram in URL|Toggle standalone/u)
    assert.match(shortcutText, /Undo|Redo|Pan view/u, 'native editing/navigation shortcut help remains available')
    await quiverFrame.locator('.toolbar .action[data-name="shortcuts"]').click()
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('.tikz-quiver-frame')
      return iframe?.contentDocument?.querySelector('#keyboard-shortcuts-pane')?.classList.contains('hidden') === true
    }, undefined, { timeout: 10_000 })

    // Edit through Quiver's actual controls and require the same CodeMirror
    // source to update. Use the repaired central semantic macro so this also
    // proves the ~/.pandoc macro projection reaches Quiver/KaTeX.
    const firstVertex = quiverFrame.locator('.vertex').first()
    await firstVertex.locator('.content').click()
    const quiverLabel = quiverFrame.locator('input.label-input')
    await quiverLabel.waitFor({ state: 'visible', timeout: 20_000 })
    assert.strictEqual(await quiverLabel.isEnabled(), true, 'selecting a Quiver vertex enables its own label editor')
    const bridgeLog = await page.evaluateHandle(() => {
      const messages: QuiverBridgeMessage[] = []
      // The window also receives messages that are not Quiver's (other
      // frames, dev tooling), so only the Quiver bridge's own types are kept.
      window.addEventListener('message', (event: MessageEvent<QuiverBridgeMessage|null>) => {
        const type = event.data?.type
        if (event.data !== null && typeof type === 'string' && type.startsWith('zettlr-quiver:')) {
          messages.push(event.data)
        }
      }, { once: false })
      return messages
    })
    await quiverLabel.fill('\\fiberprod{X}{S}{Y}')
    await page.waitForTimeout(250)
    const bridgeMessages = await bridgeLog.jsonValue()
    const quiverChange = bridgeMessages.findLast(message => message.type === 'zettlr-quiver:change')
    assert.ok(quiverChange !== undefined, `Quiver History must emit a change through the host bridge: ${JSON.stringify(bridgeMessages)}`)
    assert.match(
      requireInitialized(quiverChange.source, `a Quiver change message must carry its canonical source: ${JSON.stringify(quiverChange)}`),
      /\\fiberprod\{X\}\{S\}\{Y\}/u,
      'Quiver canonical source contains the semantic fibre-product label'
    )
    const syncOutcome = await page.waitForFunction(() => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      if (view.state.doc.toString().includes('\\fiberprod{X}{S}{Y}')) return { ok: true }
      const error = document.querySelector('.tikz-quiver-error')?.textContent?.trim()
      return error ? { ok: false, error } : null
    }, undefined, { timeout: 20_000 }).then(handle => handle.jsonValue())
    assert.deepStrictEqual(syncOutcome, { ok: true }, `Quiver edit must synchronize into CodeMirror: ${JSON.stringify(syncOutcome)}`)
    await firstVertex.locator('.label .katex').waitFor({ state: 'visible', timeout: 20_000 })
    assert.strictEqual(await firstVertex.locator('.katex-error').count(), 0, 'the central three-argument \\fiberprod macro renders through Quiver/KaTeX')

    await quiverFrame.locator('.toolbar .action[data-name="undo"]').click()
    await page.waitForFunction(() => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      return !view.state.doc.toString().includes('\\fiberprod{X}{S}{Y}')
    }, undefined, { timeout: 20_000 })
    await quiverFrame.locator('.toolbar .action[data-name="redo"]').click()
    await page.waitForFunction(() => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      return view.state.doc.toString().includes('\\fiberprod{X}{S}{Y}')
    }, undefined, { timeout: 20_000 })

    // Toggle the same RHS pane to the compiler-backed preview. No source-mode
    // handoff or second overlay exists; the authored source remains on the left.
    await rhsTikzMode.click()
    await preview.locator('.tikz-live-preview-figure .viewer-canvas img').waitFor({ state: 'visible', timeout: 60_000 })
    await page.waitForFunction(
      () => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Up to date') === true,
      undefined,
      { timeout: 60_000 }
    )
    assert.strictEqual(await preview.locator('.tikz-live-preview-error').count(), 0, 'Quiver-authored semantic macro compiles through the central TeX template')
    assert.ok((await page.locator('.cm-content').innerText()).includes('\\begin{tikzcd}'), 'mode switching never replaces the ordinary source editor')

    // Ordinary tikzpicture uses the identical RHS shell. It still defaults to
    // the compiler-backed preview, while Quiver is unavailable and the pinned
    // tikz-editor fork is available as a third registered provider.
    await page.evaluate(`(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) throw new Error('CodeMirror view disappeared')
      view.dispatch({ selection: { anchor: 1 } })
      view.focus()
    })()`)
    await preview.waitFor({ state: 'detached', timeout: 20_000 })
    const ordinaryFigure = page.locator('.tikz-figure[data-tikz-language="tikz"]')
    await ordinaryFigure.locator('svg').waitFor({ state: 'visible', timeout: 60_000 })
    await ordinaryFigure.locator('svg').click()
    await preview.waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.getAttribute('data-tikz-language') === 'tikz', undefined, { timeout: 20_000 })
    const ordinaryTikz = preview.getByRole('button', { name: 'TikZ', exact: true })
    const ordinaryQuiver = preview.getByRole('button', { name: 'Quiver', exact: true })
    const ordinaryVisual = preview.getByRole('button', { name: 'Visual', exact: true })
    assert.strictEqual(await ordinaryTikz.getAttribute('aria-pressed'), 'true', 'tikzpicture defaults to TikZ preview')
    assert.strictEqual(await ordinaryQuiver.isDisabled(), true, 'Quiver toggle is disabled for non-tikzcd source')
    assert.strictEqual(await ordinaryVisual.isEnabled(), true, 'the visual editor is enabled for an authored tikzpicture')

    await ordinaryVisual.click()
    const tikzEditorFrame = page.frameLocator('.tikz-editor-frame')
    await tikzEditorFrame.locator('[data-canvas-viewport="true"]').waitFor({ state: 'visible', timeout: 30_000 })
    const embeddedSource = tikzEditorFrame.locator('.cm-content').first()
    await embeddedSource.waitFor({ state: 'visible', timeout: 20_000 })
    assert.match(await embeddedSource.innerText(), /\\node\[dot\] \(eta\)/u, 'the embedded editor receives the authored source')
    assert.strictEqual(await preview.locator('.tikz-quiver-frame').count(), 0, 'ordinary TikZ uses tikz-editor, not Quiver')
    await page.waitForFunction(
      () => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Synced') === true,
      undefined,
      { timeout: 20_000 }
    )

    // This is the ordinary mixed workflow: leave the visual editor, hand-edit
    // source with structure the former bespoke canvas did not understand, and
    // return to visual mode. The exact authored bytes must reach tikz-editor;
    // Zettlr must not parse, canonicalize, or discard them.
    const complexTikz = String.raw`\begin{scope}[shift={(1.5,0.5)}, rotate=17]
  \foreach \x in {0,1,2} {
    \draw (\x,0) .. controls +(0,0.5) and +(0,-0.5) .. (\x,1);
  }
\end{scope}
`
    await ordinaryTikz.click()
    const complexEdit = await page.evaluate(`(() => {
      const insert = ${JSON.stringify(complexTikz)}
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      const source = view.state.doc.toString()
      const at = source.lastIndexOf('\\\\end{tikzpicture}')
      if (at < 0) return false
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } })
      view.focus()
      return true
    })()`)
    assert.strictEqual(complexEdit, true, 'the complex hand-authored TikZ edit must land in CodeMirror')
    await ordinaryVisual.click()
    await embeddedSource.waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview-status')?.textContent?.includes('Synced') === true, undefined, { timeout: 20_000 })
    await expectSourceInEmbeddedEditor(tikzEditorFrame, '\\foreach \\x in {0,1,2}')
    await expectSourceInEmbeddedEditor(tikzEditorFrame, '.. controls +(0,0.5) and +(0,-0.5) ..')

    // Drive a real upstream visual-authoring gesture, not a test-only store
    // mutation: use tikz-editor's Rectangle tool and drag on its canvas, exactly
    // as upstream's own path-tools E2E does. The generated source must flow back
    // into Zettlr without touching the complex hand-authored constructs.
    const sourceBeforeCanvasDrag = await page.evaluate(() => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      return view.state.doc.toString()
    })
    const rectTool = tikzEditorFrame.locator('button[aria-label="Rect"]').first()
    await rectTool.waitFor({ state: 'visible', timeout: 20_000 })
    await rectTool.click()
    const interactionLayer = tikzEditorFrame.locator('[data-canvas-viewport="true"] svg').last()
    await interactionLayer.waitFor({ state: 'visible', timeout: 20_000 })
    const layerBox = await interactionLayer.boundingBox()
    assert.ok(layerBox !== null, 'tikz-editor must expose its canvas interaction layer')
    const dragStartX = layerBox.x + Math.min(120, layerBox.width * 0.25)
    const dragStartY = layerBox.y + Math.min(120, layerBox.height * 0.25)
    await page.mouse.move(dragStartX, dragStartY)
    await page.mouse.down()
    await page.mouse.move(dragStartX + 120, dragStartY + 80, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(previous => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      const source = view.state.doc.toString()
      return source !== previous &&
        source.includes('\\foreach \\x in {0,1,2}') &&
        source.includes('.. controls +(0,0.5) and +(0,-0.5) ..')
    }, sourceBeforeCanvasDrag, { timeout: 20_000 })

    // Fullscreen promotion keeps the exact iframe/editor instance alive.
    await page.evaluate(() => {
      const frame = document.querySelector('.tikz-editor-frame')
      if (!(frame instanceof HTMLIFrameElement)) throw new Error('tikz-editor iframe missing')
      frame.dataset.e2eEditorIdentity = 'same-tikz-editor-instance'
    })
    await preview.locator('.tikz-live-preview-expand').click()
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') === true)
    assert.strictEqual(
      await preview.locator('.tikz-editor-frame').getAttribute('data-e2e-editor-identity'),
      'same-tikz-editor-instance',
      'fullscreen promotion preserves the exact embedded editor instance'
    )
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('.tikz-live-preview')?.classList.contains('fullscreen') !== true)

    assert.deepStrictEqual(rendererEvents, [], `the renderer emitted errors: ${JSON.stringify(rendererEvents)}`)
  })
})

async function expectSourceInEmbeddedEditor (frame: ReturnType<Page['frameLocator']>, needle: string): Promise<void> {
  await frame.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 20_000 })
  await frame.locator('.cm-content').first().evaluate((element, expected) => {
    if (element.textContent?.includes(expected) !== true) {
      throw new Error(`embedded tikz-editor source does not contain ${String(expected)}`)
    }
  }, needle)
}

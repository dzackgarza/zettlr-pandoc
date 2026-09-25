/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Live editor math-widget rendering test
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * Description:     Drives a real CodeMirror EditorView (in the suite's jsdom)
 *                  with the actual markdown parser + renderMath decoration, and
 *                  asserts that \[ \] / \( \) math is mounted as a rendered math
 *                  widget in the editor DOM -- verifying the live GUI path, not
 *                  just the md2html proxy.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderMath } from 'source/common/modules/markdown-editor/renderers/render-math'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'

// jsdom does not ship the DOM APIs CodeMirror 6 uses for layout/scheduling.
// Polyfill the minimal set so an EditorView can mount and build decorations.
function polyfillJsdomForCodeMirror (): void {
  const w = globalThis as any
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0)
    w.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (typeof w.window === 'object') w.window.ResizeObserver = w.ResizeObserver
  }
}

describe('Editor mounts math widgets for LaTeX delimiters', function () {
  before(async function () {
    this.timeout(30000)
    polyfillJsdomForCodeMirror()
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  /**
   * Renders `doc` in a headless EditorView with the cursor parked at the end
   * (away from the math, so the widget is not suppressed) and returns the
   * editor's DOM for inspection.
   */
  function renderInEditor (doc: string, anchor = doc.length): HTMLElement {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [ markdownParser(), configField, renderMath ]
    })
    const view = new EditorView({ state, parent: document.body })
    return view.dom
  }

  it('mounts a DISPLAY widget for a mid-paragraph \\[ … \\] block', function () {
    const dom = renderInEditor('with invariants\n\\[\n\\RR = \\RR\n\\]\nand complement')
    const widget = dom.querySelector('.preview-math mjx-container[display="true"]')
    assert.ok(widget !== null, 'expected a mounted display-math widget')
    assert.match(widget?.textContent ?? '', /ℝ/)
  })

  it('mounts a DISPLAY widget when the close is a trailing ".\\]"', function () {
    const dom = renderInEditor('with invariants\n\\[\n\\RR = \\RR\n.\\]\nand complement')
    const widget = dom.querySelector('.preview-math mjx-container[display="true"]')
    assert.ok(widget !== null, 'expected a mounted display-math widget for the .\\] close')
  })

  it('mounts an INLINE widget for \\( … \\) in prose', function () {
    const dom = renderInEditor('the set \\(\\RR\\) is nice')
    const container = dom.querySelector('.preview-math mjx-container')
    assert.ok(container !== null, 'expected a mounted inline-math widget')
    assert.ok(container?.getAttribute('display') !== 'true', 'inline math must not be display mode')
  })

  it('mounts spaced \\( … \\) math containing ordinary TeX commands', function () {
    const dom = renderInEditor(
      'the moduli space \\( \\overline{{ \\mathcal{M}_{g, n} }} \\) is compact',
    )
    const widget = [...dom.querySelectorAll<HTMLElement>('.preview-math')].find(
      element => element.dataset.equation === ' \\overline{{ \\mathcal{M}_{g, n} }} ',
    )
    assert.ok(widget !== null, 'expected the entire spaced backslash-delimited expression to render')
    assert.ok(widget?.querySelector('mjx-container') !== null, 'expected MathJax content inside the widget')
  })

  it('still mounts a DISPLAY widget for a $$ block (regression)', function () {
    const dom = renderInEditor('text\n\n$$\n\\RR\n$$\n\nmore')
    const widget = dom.querySelector('.preview-math mjx-container[display="true"]')
    assert.ok(widget !== null, 'expected a mounted $$ display-math widget')
  })

  it('renders Pandoc RawInline align* environments as display mathematics', function () {
    const doc = String.raw`\begin{align*}
\{ \phi_i\colon U_i \to \RR^n \}
.\end{align*}

such that for each nonempty overlap $U_i \cap U_j$, the transition maps

\begin{align*}
\phi_j \circ \phi_i^{-1} \colon \phi_i(U_i \cap U_j) \to \phi_j(U_i \cap U_j)
.\end{align*}`
    const dom = renderInEditor(doc, doc.indexOf('such that'))
    const displayWidgets = [...dom.querySelectorAll<HTMLElement>('.preview-math')]
      .filter(widget => widget.dataset.equation?.startsWith('\\begin{align*}') === true)

    assert.equal(displayWidgets.length, 2, 'expected both align* environments to render')
    for (const widget of displayWidgets) {
      assert.ok(
        widget.querySelector('mjx-container[display="true"]') !== null,
        'align* must render in display mode',
      )
    }
  })

  it('does not render non-math RawInline TeX as mathematics', function () {
    const dom = renderInEditor(String.raw`Before \textbf{bold} after.`)
    assert.equal(dom.querySelectorAll('.preview-math').length, 0)
  })
})

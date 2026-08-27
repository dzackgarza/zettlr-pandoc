/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Widget DOM reuse across renderers
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Proves that a widget never inherits the DOM element of a
 *                  different renderer. Every renderer's widget is wrapped in
 *                  one shared wrapper type, which is what CodeMirror compares
 *                  before it recycles a widget's element, so a citation's
 *                  element can otherwise be handed to the math renderer and
 *                  keep the citation's classes -- and its background.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderCitations } from 'source/common/modules/markdown-editor/renderers/render-citations'
import { renderMath } from 'source/common/modules/markdown-editor/renderers/render-math'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'

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
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({})
    })
  }
}

const DOC = 'We refer to [@Ols04]$x^2 = y$ afterwards.\n'

describe('Editor keeps renderer widgets in their own DOM', function () {
  const views: EditorView[] = []
  const originalCitationCallback = window.getCitationCallback

  before(async function () {
    this.timeout(30000)
    polyfillJsdomForCodeMirror()
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  after(function () {
    window.getCitationCallback = originalCitationCallback
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  it('does not give the math widget the citation widget element', function () {
    window.getCitationCallback = () => () => '(Olsson 2004)'
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: DOC.length - 1 },
      extensions: [ markdownParser(), configField, renderCitations, renderMath ]
    })
    const view = new EditorView({ state, parent: document.body })
    views.push(view)

    const citation = view.dom.querySelector('.citeproc-citation')
    assert.ok(citation !== null, 'the citation must render before the state changes')

    // Put the cursor inside the citation. Its widget gives way to the source,
    // so the decoration that follows -- the math -- takes over the widget slot
    // the citation held, and CodeMirror offers it the citation's element.
    view.dispatch({ selection: { anchor: DOC.indexOf('@Ols04') + 2 } })

    const citationsHoldingMath = view.dom.querySelectorAll('.citeproc-citation mjx-container')
    assert.equal(
      citationsHoldingMath.length, 0,
      'math must not be rendered into a citation element, which paints the citation background behind it'
    )
    const math = view.dom.querySelector('.preview-math')
    assert.ok(math !== null, 'the math must still render as math')
    assert.equal(math.classList.contains('citeproc-citation'), false)
  })
})

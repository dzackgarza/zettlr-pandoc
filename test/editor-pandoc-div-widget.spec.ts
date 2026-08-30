/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Live editor Pandoc fenced-div rendering tests
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * Description:     Drives a real CodeMirror EditorView with the Markdown
 *                  parser and Pandoc renderer to verify the cursor-sensitive
 *                  semantic presentation of fenced divs.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { forceParsing } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, redo, undo } from '@codemirror/commands'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderEmphasis } from 'source/common/modules/markdown-editor/renderers/render-emphasis'
import { renderLinks } from 'source/common/modules/markdown-editor/renderers/render-links'
import { renderMath } from 'source/common/modules/markdown-editor/renderers/render-math'
import { renderPandoc } from 'source/common/modules/markdown-editor/renderers/render-pandoc-div-span'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'

function polyfillJsdomForCodeMirror (): void {
  const w = globalThis as any
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    w.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (typeof w.window === 'object') {
      w.window.ResizeObserver = w.ResizeObserver
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }
}

describe('Editor presents Pandoc fenced divs semantically', function () {
  const views: EditorView[] = []

  before(async function () {
    this.timeout(30000)
    polyfillJsdomForCodeMirror()
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (
    doc: string,
    anchor = doc.length,
    extensions: NonNullable<Parameters<typeof EditorState.create>[0]>['extensions'] = [ markdownParser(), renderPandoc ]
  ): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [ extensions, EditorState.allowMultipleSelections.of(true) ],
    })
    const view = new EditorView({ state, parent: document.body })
    // On a cold parser the markdown parse can miss CodeMirror's synchronous
    // time slice, leaving the first render with a partial tree while these
    // specs assert synchronously. forceParsing completes the parse and applies
    // the resulting tree through a real view update.
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    views.push(view)
    return view
  }

  const hybridPreviewDoc = `::: theorem
Ordinary prose with *emphasis*, [a link](https://example.com), inline $x=y$, and another $u=v$.

$$
z=w
$$
:::

outside`

  const hybridPreviewExtensions = [ markdownParser(), renderPandoc, renderEmphasis, renderLinks, renderMath ]

  function renderedEquations (view: EditorView): string[] {
    return [ ...view.dom.querySelectorAll<HTMLElement>('.preview-math') ]
      .map(element => element.dataset.equation?.trim() ?? '')
  }

  function activeHybridDiv (view: EditorView): Element {
    const active = view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="result"]')
    assert.ok(active !== null, 'the theorem shell must be raw while its content is being edited')
    assert.equal(view.dom.querySelector('pandoc-div-wrapper'), null, 'the semantic panel must be disabled while editing inside it')
    return active
  }

  it('shows an inactive semantic panel while preserving authored content and inner renderers', function () {
    const doc = '::: {.layout .definition #term title="Term" style="display:none"}\nA *set* has $\\RR$.\n:::\n\noutside'
    const view = createEditor(doc, doc.length, [ markdownParser(), renderPandoc, renderEmphasis, renderMath ])

    assert.equal(view.state.doc.toString(), doc)
    assert.equal(view.state.selection.main.anchor, doc.length)

    const opening = view.dom.querySelector('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
    const panel = view.dom.querySelector('pandoc-div-wrapper[data-pandoc-div-family="definition"]')
    const closing = view.dom.querySelector('pandoc-div-close-wrapper[data-pandoc-div-state="inactive"]')
    assert.ok(opening !== null, `expected a collapsed opening-fence label: ${view.dom.innerHTML}`)
    assert.equal(opening?.getAttribute('data-pandoc-div-label'), 'Definition')
    assert.ok(panel !== null, 'expected a semantic content panel')
    assert.ok(panel?.classList.contains('layout'))
    assert.ok(panel?.classList.contains('definition'))
    assert.equal(opening?.getAttribute('data-pandoc-authored-id'), 'term')
    assert.match(opening?.getAttribute('title') ?? '', /#term/)
    assert.match(opening?.getAttribute('title') ?? '', /Term/)
    assert.equal(panel?.getAttribute('style'), null, 'unsafe authored styling must not alter the editor layout')
    assert.equal(view.dom.querySelectorAll('#term').length, 0, 'split presentation wrappers must not duplicate authored DOM IDs')
    assert.ok(closing !== null, 'expected a collapsed closing-fence wrapper')
    assert.ok(panel?.querySelector('.preview-math mjx-container') !== null, 'inner math should remain rendered')
    assert.match(panel?.textContent ?? '', /A set has/)
  })

  it('reveals the div shell while preserving cursor-local nested preview behavior', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('Ordinary'), hybridPreviewExtensions)
    const active = activeHybridDiv(view)

    assert.match(active.textContent ?? '', /::: theorem/)
    assert.match(active.textContent ?? '', /:::/)
    assert.equal(view.state.doc.toString(), hybridPreviewDoc)
  })

  it('keeps inline equations rendered while editing ordinary theorem prose', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('Ordinary'), hybridPreviewExtensions)
    activeHybridDiv(view)

    assert.deepStrictEqual(renderedEquations(view).filter(equation => equation !== 'z=w'), [ 'x=y', 'u=v' ])
  })

  it('keeps display equations rendered while editing ordinary theorem prose', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('Ordinary'), hybridPreviewExtensions)
    activeHybridDiv(view)

    const display = view.dom.querySelector<HTMLElement>('.preview-math mjx-container[display="true"]')?.closest<HTMLElement>('.preview-math')
    assert.equal(display?.dataset.equation?.trim(), 'z=w')
  })

  it('makes only the selected inline equation raw', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('x=y') + 1, hybridPreviewExtensions)
    const active = activeHybridDiv(view)

    assert.deepStrictEqual(renderedEquations(view), [ 'u=v', 'z=w' ])
    assert.match(active.textContent ?? '', /\$x=y\$/)
  })

  it('makes only the selected display equation raw', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('z=w') + 1, hybridPreviewExtensions)
    const active = activeHybridDiv(view)

    assert.deepStrictEqual(renderedEquations(view), [ 'x=y', 'u=v' ])
    assert.match(active.textContent ?? '', /z=w/)
  })

  it('keeps emphasis rendered while editing unrelated theorem prose', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('Ordinary'), hybridPreviewExtensions)
    const active = activeHybridDiv(view)
    const visibleText = active.textContent ?? ''

    assert.doesNotMatch(visibleText, /\*emphasis\*/)
    assert.match(visibleText, /emphasis/)
  })

  it('keeps links rendered while editing unrelated theorem prose', function () {
    const view = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('Ordinary'), hybridPreviewExtensions)
    const active = activeHybridDiv(view)
    const visibleText = active.textContent ?? ''

    assert.doesNotMatch(visibleText, /https:\/\/example\.com/)
    assert.match(visibleText, /a link/)
  })

  it('makes only selected emphasis raw while links and equations remain rendered', function () {
    const emphasisView = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('emphasis') + 1, hybridPreviewExtensions)
    const activeEmphasis = activeHybridDiv(emphasisView)
    assert.match(activeEmphasis.textContent ?? '', /\*emphasis\*/)
    assert.doesNotMatch(activeEmphasis.textContent ?? '', /https:\/\/example\.com/)
    assert.deepStrictEqual(renderedEquations(emphasisView), [ 'x=y', 'u=v', 'z=w' ])
  })

  it('makes only the selected link raw while emphasis and equations remain rendered', function () {
    const linkView = createEditor(hybridPreviewDoc, hybridPreviewDoc.indexOf('a link') + 1, hybridPreviewExtensions)
    const activeLink = activeHybridDiv(linkView)
    assert.match(activeLink.textContent ?? '', /\[a link\]\(https:\/\/example\.com\)/)
    assert.doesNotMatch(activeLink.textContent ?? '', /\*emphasis\*/)
    assert.deepStrictEqual(renderedEquations(linkView), [ 'x=y', 'u=v', 'z=w' ])
  })

  it('reveals the complete raw div for cursor positions on every authored part', function () {
    const doc = '::: {.definition #term}\nA set.\n:::\n\noutside'
    const view = createEditor(doc)
    const positions = [
      doc.indexOf(':::'),
      doc.indexOf('.definition'),
      doc.indexOf('A set'),
      doc.lastIndexOf(':::'),
    ]

    for (const anchor of positions) {
      view.dispatch({ selection: { anchor } })
      const active = view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-state="active"]')
      assert.ok(active !== null, `expected raw editing state at ${anchor}`)
      assert.match(active?.textContent ?? '', /::: \{\.definition #term\}/)
      assert.match(active?.textContent ?? '', /A set\./)
      assert.equal(view.dom.querySelector('pandoc-div-wrapper'), null)
      assert.equal(view.state.doc.toString(), doc)
      assert.equal(view.state.selection.main.anchor, anchor)
    }

    view.dispatch({ selection: { anchor: doc.length } })
    assert.ok(view.dom.querySelector('pandoc-div-wrapper[data-pandoc-div-state="inactive"]') !== null)
    assert.equal(view.dom.querySelector('pandoc-div-active-wrapper'), null)
  })

  it('makes only the deepest selected div active and keeps its container lightweight', function () {
    const doc = '::: theorem\nOuter.\n\n::: proof\nInner.\n:::\n\nAfter inner.\n:::\n\noutside'
    const innerPosition = doc.indexOf('Inner')
    const view = createEditor(doc, innerPosition)

    const active = view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="proof"]')
    const ancestor = view.dom.querySelector('pandoc-div-ancestor-wrapper[data-pandoc-div-family="result"]')
    assert.ok(active !== null, 'the inner proof should be the sole raw div')
    assert.ok(ancestor !== null, 'the containing theorem should remain a rendered guide')
    assert.equal(view.dom.querySelectorAll('pandoc-div-active-wrapper').length, 1)
    assert.equal(view.dom.querySelector('pandoc-div-wrapper.theorem'), null)

    view.dispatch({ selection: { anchor: doc.indexOf('::: theorem') + 1 } })
    assert.ok(view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="result"]') !== null, 'selecting the outer fence should activate the outer div')
    assert.equal(view.dom.querySelectorAll('pandoc-div-active-wrapper').length, 1)
  })

  it('uses the first recognized authored class for each semantic family', function () {
    const docs = [
      [ '.layout .lemma .warning', 'result', 'Lemma' ],
      [ '.definition', 'definition', 'Definition' ],
      [ '.remark', 'explanation', 'Remark' ],
      [ '.problem', 'task', 'Problem' ],
      [ '.danger', 'warning', 'Danger' ],
      [ '.solution', 'proof', 'Solution' ],
      [ '.layout-only', 'generic', '.layout-only' ],
    ] as const
    const doc = `${docs.map(([ classes ], index) => `::: {${classes}}\nBlock ${index}.\n:::`).join('\n\n')}\n\noutside`
    const view = createEditor(doc)
    const panels = [ ...view.dom.querySelectorAll('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]') ]

    assert.equal(panels.length, docs.length)
    panels.forEach((panel, index) => {
      assert.equal(panel.getAttribute('data-pandoc-div-family'), docs[index][1])
      assert.equal(panel.getAttribute('data-pandoc-div-label'), docs[index][2])
    })
  })

  it('activates the deepest div independently for every selection range', function () {
    const doc = '::: theorem\nOuter.\n\n::: proof\nInner.\n:::\n\nTail.\n:::\n\noutside'
    const view = createEditor(doc)
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(doc.indexOf('Outer')),
        EditorSelection.cursor(doc.indexOf('Inner')),
      ]),
    })

    assert.ok(view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="result"]') !== null)
    assert.ok(view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="proof"]') !== null)
  })

  it('keeps the existing renderPandoc preference authoritative', function () {
    const doc = '::: definition\nBody.\n:::\n\noutside'
    const view = createEditor(doc, doc.length, [ markdownParser() ])

    assert.equal(view.dom.querySelector('pandoc-div-wrapper'), null)
    assert.equal(view.dom.querySelector('pandoc-div-open-wrapper'), null)
    assert.match(view.dom.textContent ?? '', /::: definition/)
  })

  it('moves the cursor to the source from mouse or keyboard label activation', function () {
    const doc = '::: definition\nBody.\n:::\n\noutside'
    const view = createEditor(doc)
    const label = view.dom.querySelector('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
    assert.ok(label !== null)

    label?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    assert.equal(view.state.selection.main.anchor, 0)
    assert.ok(view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="definition"]') !== null)

    view.dispatch({ selection: { anchor: doc.length } })
    const restoredLabel = view.dom.querySelector('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
    restoredLabel?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    assert.equal(view.state.selection.main.anchor, 0)
  })

  it('leaves malformed and incomplete fenced divs as raw source', function () {
    const doc = '::: {.definition}\nUnclosed *content*'
    const view = createEditor(doc, doc.length, [ markdownParser(), renderPandoc, renderEmphasis ])

    assert.equal(view.dom.querySelector('pandoc-div-wrapper'), null)
    assert.match(view.dom.textContent ?? '', /::: \{\.definition\}/)
  })

  it('maps Quarto classless and shorthand divs to the exact same rendering pipeline as amsthm definitions', function () {
    const quartoDefs = [
      { doc: '::: {#def-cauchy}\nA continuous function is Cauchy.\n:::\n\noutside', family: 'definition', label: 'Definition', id: 'def-cauchy' },
      { doc: '::: {.def #term}\nA fundamental term.\n:::\n\noutside', family: 'definition', label: 'Definition', id: 'term' },
      { doc: '::: {#thm-main}\nEvery finite group has a composition series.\n:::\n\noutside', family: 'result', label: 'Theorem', id: 'thm-main' },
      { doc: '::: {.thm}\nA standard theorem.\n:::\n\noutside', family: 'result', label: 'Theorem', id: '' },
      { doc: '::: {#lem-zorn}\nEvery poset has a maximal element.\n:::\n\noutside', family: 'result', label: 'Lemma', id: 'lem-zorn' },
      { doc: '::: {.prp #main}\nA proposition.\n:::\n\noutside', family: 'result', label: 'Proposition', id: 'main' },
      { doc: '::: {#cor-1}\nA corollary.\n:::\n\noutside', family: 'result', label: 'Corollary', id: 'cor-1' },
      { doc: '::: {#exm-circle}\nAn example of a manifold.\n:::\n\noutside', family: 'explanation', label: 'Example', id: 'exm-circle' },
      { doc: '::: {#rem-1}\nA notable remark.\n:::\n\noutside', family: 'explanation', label: 'Remark', id: 'rem-1' },
      { doc: '::: {.prf}\nProof follows.\n:::\n\noutside', family: 'proof', label: 'Proof', id: '' }
    ]

    for (const specimen of quartoDefs) {
      const view = createEditor(specimen.doc, specimen.doc.length, [ markdownParser(), renderPandoc ])
      const opening = view.dom.querySelector('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
      const panel = view.dom.querySelector(`pandoc-div-wrapper[data-pandoc-div-family="${specimen.family}"]`)
      const closing = view.dom.querySelector('pandoc-div-close-wrapper[data-pandoc-div-state="inactive"]')

      assert.ok(opening !== null, `expected opening wrapper for ${specimen.doc}`)
      assert.equal(opening?.getAttribute('data-pandoc-div-label'), specimen.label)
      assert.equal(opening?.getAttribute('data-pandoc-div-family'), specimen.family)
      assert.ok(panel !== null, `expected panel wrapper with family ${specimen.family} for ${specimen.doc}`)
      assert.ok(closing !== null, `expected closing wrapper for ${specimen.doc}`)
      if (specimen.id !== '') {
        assert.equal(opening?.getAttribute('data-pandoc-authored-id'), specimen.id)
      }
    }
  })
})


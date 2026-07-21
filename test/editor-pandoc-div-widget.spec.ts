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
    extensions: Parameters<typeof EditorState.create>[0]['extensions'] = [ markdownParser(), renderPandoc ]
  ): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [ extensions, EditorState.allowMultipleSelections.of(true) ],
    })
    const view = new EditorView({ state, parent: document.body })
    views.push(view)
    return view
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

  it('reveals all nested Markdown source while any part of the div is active', function () {
    const doc = '::: definition\nA *set* has [$\\RR$](https://example.com).\n:::\n\noutside'
    const view = createEditor(doc, doc.indexOf('set'), [ markdownParser(), renderPandoc, renderEmphasis, renderLinks, renderMath ])

    const active = view.dom.querySelector('pandoc-div-active-wrapper[data-pandoc-div-family="definition"]')
    assert.ok(active !== null)
    assert.match(active?.textContent ?? '', /\*set\*/)
    assert.match(active?.textContent ?? '', /\$\\RR\$/)
    assert.match(active?.textContent ?? '', /https:\/\/example\.com/)
    assert.equal(active?.querySelector('.preview-math'), null)
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

  it('preserves ordinary editing and undo history inside an active div', function () {
    const doc = '::: definition\nBody.\n:::\n\noutside'
    const insertion = doc.indexOf('Body') + 4
    const view = createEditor(doc, insertion, [ markdownParser(), renderPandoc, history() ])

    view.dispatch({ changes: { from: insertion, insert: ' text' } })
    assert.equal(view.state.doc.toString(), '::: definition\nBody text.\n:::\n\noutside')
    assert.equal(undo(view), true)
    assert.equal(view.state.doc.toString(), doc)
    assert.equal(redo(view), true)
    assert.equal(view.state.doc.toString(), '::: definition\nBody text.\n:::\n\noutside')
  })
})

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc attribute-block rendering red proofs (issue #11)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the attribute-block rendering contract: a Pandoc
 *                  attribute block ({#id .class key=val}) attached to a
 *                  rendered element is machinery, not content. With the
 *                  cursor off the line the block must be rendered away —
 *                  on headings, table captions, and every other carrier —
 *                  and revealed again when the cursor enters the line,
 *                  exactly like the fenced-div renderer already treats its
 *                  open fence. The proofs drive the PRODUCTION renderer
 *                  aggregate (renderers()), so a renderer added or removed
 *                  from the app's preview set is what is being tested.
 *
 * END HEADER
 */

import './provision-renderer-window-seams'
import { strict as assert } from 'assert'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderers } from 'source/common/modules/markdown-editor/renderers'
import { configField, getDefaultConfig } from 'source/common/modules/markdown-editor/util/configuration'

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

const DOC = `# Central compactification problem {#sec:central-problem}

The prose paragraph keeps the caret away from every carrier line.

## Unnumbered variant {#sec:two .unnumbered}

| Lattice | Signature |
|---------|-----------|
| U       | (1,1)     |

: Coble lattices of Halphen type {#tbl:coble-lattices}

A closing paragraph.
`

describe('Pandoc attribute-block rendering (issue #11)', function () {
  const views: EditorView[] = []

  before(function () {
    polyfillJsdomForCodeMirror()
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (anchor: number): EditorView {
    const config = getDefaultConfig()
    config.renderingMode = 'preview'
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor },
      extensions: [ markdownParser(), configField.init(() => config), renderers(config) ],
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, DOC.length, 5000), 'the syntax tree must be fully parsed before asserting')
    views.push(view)
    return view
  }

  /** The visible text of the line containing the given needle. */
  function lineText (view: EditorView, needle: string): string {
    const lines = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-line'))
    const line = lines.find(candidate => (candidate.textContent ?? '').includes(needle))
    assert.ok(line !== undefined, `no rendered line contains ${needle}`)
    return line.textContent ?? ''
  }

  it('renders the heading attribute block away when the cursor is elsewhere', function () {
    const view = createEditor(DOC.indexOf('prose paragraph'))
    const text = lineText(view, 'Central compactification problem')
    assert.ok(!text.includes('{#sec:central-problem}'), `the attribute block must be rendered away, saw: ${text}`)
    assert.ok(text.includes('Central compactification problem'), 'the heading text itself must stay visible')
  })

  it('renders multi-entry attribute blocks away on every heading', function () {
    const view = createEditor(DOC.indexOf('prose paragraph'))
    const text = lineText(view, 'Unnumbered variant')
    assert.ok(!text.includes('{#sec:two .unnumbered}'), `the attribute block must be rendered away, saw: ${text}`)
  })

  it('renders the table-caption attribute block away', function () {
    const view = createEditor(DOC.indexOf('prose paragraph'))
    const text = lineText(view, 'Coble lattices of Halphen type')
    assert.ok(!text.includes('{#tbl:coble-lattices}'), `the caption attribute block must be rendered away, saw: ${text}`)
    assert.ok(text.includes('Coble lattices of Halphen type'), 'the caption text itself must stay visible')
  })

  it('reveals the attribute block while the cursor is on the carrier line', function () {
    const view = createEditor(DOC.indexOf('compactification'))
    const text = lineText(view, 'Central compactification problem')
    assert.ok(text.includes('{#sec:central-problem}'), `the attribute block must reveal for editing, saw: ${text}`)
  })
})

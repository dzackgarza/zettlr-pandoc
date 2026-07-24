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
 *                  The reveal threshold is the user's
 *                  previewModeShowSyntaxWhenCursorIsAdjacent preference, so
 *                  the editor configuration is a hard dependency: an editor
 *                  assembled without it reports that, rather than hiding
 *                  attribute blocks on a preference nobody set.
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
import { renderPandocAttributes } from 'source/common/modules/markdown-editor/renderers/render-pandoc-attributes'
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

![A figure caption](figure.png){#fig:one .wide}

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

  function createEditor (anchor: number, showSyntaxWhenAdjacent?: boolean): EditorView {
    const config = getDefaultConfig()
    config.renderingMode = 'preview'
    if (showSyntaxWhenAdjacent !== undefined) {
      config.previewModeShowSyntaxWhenCursorIsAdjacent = showSyntaxWhenAdjacent
    }
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

  /**
   * The production attribute-block plugin in an editor that was assembled
   * WITHOUT the editor configuration — the state in which the renderer's
   * dependency is not satisfied. The renderer aggregate cannot be built that
   * way at all (its mode switcher derives from the same field), so the plugin
   * itself is the boundary where this can be observed.
   */
  function createUnconfiguredEditor (anchor: number): { view: EditorView, exceptions: unknown[] } {
    const exceptions: unknown[] = []
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor },
      extensions: [
        markdownParser(),
        EditorView.exceptionSink.of(exception => { exceptions.push(exception) }),
        renderPandocAttributes,
      ],
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, DOC.length, 5000), 'the syntax tree must be fully parsed before asserting')
    views.push(view)
    return { view, exceptions }
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

  it('renders the image attribute block away when the cursor is elsewhere (issue #27)', function () {
    const view = createEditor(DOC.indexOf('prose paragraph'))
    const text = lineText(view, 'A figure caption')
    assert.ok(!text.includes('{#fig:one .wide}'), `the image attribute block must be rendered away, saw: ${text}`)
    assert.ok(text.includes('A figure caption'), 'the image caption text itself must stay visible')
  })

  it('reveals the image attribute block while the cursor is on the image line (issue #27)', function () {
    const view = createEditor(DOC.indexOf('A figure caption'))
    const text = lineText(view, 'A figure caption')
    assert.ok(text.includes('{#fig:one .wide}'), `the image attribute block must reveal for editing, saw: ${text}`)
  })

  it('decides the reveal threshold by the user preference, not by a value of its own', function () {
    // A caret resting exactly on the carrier line's first position is the case
    // the preference governs: adjacency counts as "on the line" only when the
    // user asked for it. Both editors are identical apart from that setting.
    const revealing = createEditor(0, true)
    assert.ok(
      lineText(revealing, 'Central compactification problem').includes('{#sec:central-problem}'),
      'with the preference on, a caret adjacent to the line reveals the block'
    )

    const hiding = createEditor(0, false)
    assert.ok(
      !lineText(hiding, 'Central compactification problem').includes('{#sec:central-problem}'),
      'with the preference off, the same caret leaves the block rendered away'
    )
  })

  it('reports an editor assembled without the configuration instead of hiding blocks on a preference nobody set', function () {
    const { view, exceptions } = createUnconfiguredEditor(DOC.indexOf('prose paragraph'))

    // The caret is nowhere near the carrier line, so any renderer that reached
    // a decision at all would have hidden the block. The blocks staying put is
    // the observable difference between reading the preference and inventing
    // one.
    const text = lineText(view, 'Central compactification problem')
    assert.ok(
      text.includes('{#sec:central-problem}'),
      `an unconfigured editor must not decide the user's preference for them, saw: ${text}`
    )
    assert.strictEqual(exceptions.length, 1, 'the missing configuration is reported through the editor\'s exception channel')
    assert.ok(exceptions[0] instanceof Error, `the report carries a real error, got ${String(exceptions[0])}`)
  })
})

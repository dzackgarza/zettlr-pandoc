/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Footnote body background
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A footnote body ends where its indentation ends, and nothing
 *                  in the source says so. The background tint is what tells the
 *                  user which lines Pandoc will put in the note, so the tinted
 *                  set must equal the parser's FootnoteRef extent exactly: a
 *                  line that lost its indent must come out untinted.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { footnoteBackground } from 'source/common/modules/markdown-editor/plugins/footnote-background'

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
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({})
    })
  }
}

describe('Footnote body background', function () {
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

  /**
   * The 1-based numbers of the lines the production extension tints.
   */
  function tintedLines (doc: string): number[] {
    const state = EditorState.create({
      doc,
      extensions: [ markdownParser(), footnoteBackground ]
    })
    const view = new EditorView({ state, parent: document.body })
    views.push(view)
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed')

    const numbers: number[] = []
    for (const line of view.dom.querySelectorAll('.cm-footnote-body')) {
      const pos = view.posAtDOM(line)
      numbers.push(view.state.doc.lineAt(pos).number)
    }
    return numbers
  }

  it('tints the label line and its indented body', function () {
    const doc = [
      'Prose above.', // 1
      '',             // 2
      '[^1]:',        // 3
      '    Inside.',  // 4
      '',             // 5
      'Prose below.'  // 6
    ].join('\n')
    assert.deepEqual(tintedLines(doc), [ 3, 4 ])
  })

  it('tints a body written on the label line', function () {
    const doc = [ '[^3]: Inside.', '', 'Prose below.' ].join('\n')
    assert.deepEqual(tintedLines(doc), [1])
  })

  it('spans the blank line between two body paragraphs', function () {
    const doc = [
      '[^2]:',              // 1
      '    First para.',    // 2
      '',                   // 3
      '    Second para.',   // 4
      '',                   // 5
      'Prose below.'        // 6
    ].join('\n')
    assert.deepEqual(tintedLines(doc), [ 1, 2, 3, 4 ])
  })

  it('leaves a de-indented continuation untinted', function () {
    const doc = [
      '[^2]:',                          // 1
      '    First para.',                // 2
      '',                               // 3
      'Meant to be in the note, but',   // 4 — lost its indent
      'this is prose again.'            // 5
    ].join('\n')
    assert.deepEqual(tintedLines(doc), [ 1, 2 ])
  })
})

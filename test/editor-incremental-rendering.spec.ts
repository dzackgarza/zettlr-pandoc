/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Incremental block widget rendering
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The block widget field renders again only what a
 *                  transaction can change. These tests state the two halves
 *                  of that contract: the work of a transaction does not
 *                  follow the length of the document, and the widgets after
 *                  a sequence of transactions are the widgets that a new
 *                  editor shows for the same document and selection.
 *
 * END HEADER
 */

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { strict as assert } from 'assert'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderBlockWidgets } from 'source/common/modules/markdown-editor/renderers/base-renderer'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'

class MathMarker extends WidgetType {
  constructor (readonly source: string) {
    super()
  }

  eq (other: MathMarker): boolean {
    return other.source === this.source
  }

  toDOM (): HTMLElement {
    return document.createElement('span')
  }
}

interface CountedEditor {
  state: EditorState
  /** The number of widgets that the renderer made since the last reset. */
  made: () => number
  reset: () => void
}

/** The syntax tree of a state covers the whole document only after this. */
function parsed (state: EditorState): EditorState {
  assert.notEqual(ensureSyntaxTree(state, state.doc.length, 60_000), null, 'the document must parse')
  return state.update({}).state
}

function countedEditor (doc: string, anchor: number): CountedEditor {
  let made = 0
  const renderer = renderBlockWidgets([ 'InlineCode', 'FencedCode' ], () => true, (state, node) => {
    made += 1
    return new MathMarker(state.sliceDoc(node.from, node.to))
  })
  const state = parsed(EditorState.create({
    doc,
    selection: { anchor },
    extensions: [ markdownParser(), configField, renderer ]
  }))
  return { state, made: () => made, reset: () => { made = 0 } }
}

function paragraphs (count: number): string {
  let doc = ''
  for (let i = 0; i < count; i++) {
    doc += `Paragraph ${i} holds $x_{${i}}$ and $y_{${i}}$ in a sentence.\n\n`
  }
  return doc
}

function widgets (state: EditorState): string[] {
  const found: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    // The block widget field provides a set; no extension of these states provides a function.
    const set = source as DecorationSet
    const cursor = set.iter()
    while (cursor.value !== null) {
      found.push(`${cursor.from}-${cursor.to}:${state.sliceDoc(cursor.from, cursor.to)}`)
      cursor.next()
    }
  }
  return found.sort()
}

describe('Block widgets follow the size of a change', function () {
  this.timeout(120_000)

  function widgetsMadeByTypedCharacter (paragraphCount: number): number {
    const doc = paragraphs(paragraphCount)
    const editor = countedEditor(doc, 0)
    const position = doc.indexOf('holds', doc.length / 2)
    editor.reset()
    const typed = editor.state.update({ changes: { from: position, insert: 'x' }, selection: { anchor: position + 1 } }).state
    assert.equal(widgets(typed).length, 2 * paragraphCount)
    return editor.made()
  }

  it('makes the same number of widgets for a typed character in a short and in a long document', function () {
    const short = widgetsMadeByTypedCharacter(40)
    const long = widgetsMadeByTypedCharacter(4000)
    assert.equal(long, short)
    assert.ok(short <= 4, `a typed character made ${short} widgets`)
  })

  it('makes no widget when the cursor moves through text', function () {
    const doc = paragraphs(400)
    const position = doc.indexOf('Paragraph 200')
    const editor = countedEditor(doc, position)
    editor.reset()
    let state = editor.state
    for (let step = 1; step <= 8; step++) {
      state = state.update({ selection: { anchor: position + step } }).state
    }
    assert.equal(editor.made(), 0)
    assert.equal(widgets(state).length, 800)
  })

  it('shows the source under the cursor and renders it again when the cursor leaves', function () {
    const doc = paragraphs(3)
    const math = doc.indexOf('$x_{1}$')
    const editor = countedEditor(doc, 0)
    const inside = editor.state.update({ selection: { anchor: math + 2 } }).state
    assert.deepEqual(widgets(inside), widgets(countedEditor(doc, math + 2).state))
    assert.equal(widgets(inside).length, 5)
    const outside = inside.update({ selection: { anchor: 0 } }).state
    assert.equal(widgets(outside).length, 6)
  })

  it('has the widgets of a new editor after each of a sequence of edits', function () {
    const doc = paragraphs(30)
    const at = (needle: string, state: EditorState): number => {
      const position = state.sliceDoc().indexOf(needle)
      assert.notEqual(position, -1, `the document must contain ${needle}`)
      return position
    }
    const edits: Array<(state: EditorState) => TransactionSpec> = [
      state => ({ changes: { from: at('holds $x_{4}$', state), insert: 'now ' } }),
      state => ({ changes: { from: at('$y_{7}$', state), to: at('$y_{7}$', state) + 7, insert: '' } }),
      state => ({ changes: { from: at('Paragraph 9 ', state), insert: 'New $z$ block.\n\n' } }),
      state => ({ changes: { from: at('Paragraph 12 ', state), to: at('Paragraph 14 ', state), insert: '' } }),
      state => ({ changes: { from: at(' and $y_{15}$', state), insert: '\n\n' } }),
      state => ({ changes: { from: at('Paragraph 18 ', state), insert: '```\ncode $a$\n```\n\n' } }),
      state => ({ changes: { from: at('```\ncode', state), to: at('```\ncode', state) + 1, insert: '' } }),
      state => ({ selection: { anchor: at('$x_{20}$', state) + 3 } }),
      state => ({ changes: { from: at('x_{20}', state), insert: 'q' } }),
      state => ({ selection: { anchor: 0 } }),
      state => ({ changes: { from: state.doc.length, insert: 'Last $w$ line.\n' } }),
      state => ({ changes: { from: 0, to: at('Paragraph 2 ', state), insert: '' } }),
      state => ({ changes: [
        { from: at('$x_{3}$', state) + 1, insert: 'a' },
        { from: at('$x_{25}$', state) + 1, insert: 'b' }
      ] })
    ]

    let state = countedEditor(doc, 0).state
    for (const [ index, edit ] of edits.entries()) {
      state = parsed(state.update(edit(state)).state)
      const fresh = countedEditor(state.sliceDoc(), state.selection.main.anchor).state
      assert.deepEqual(widgets(state), widgets(fresh), `edit ${index}`)
    }
  })
})

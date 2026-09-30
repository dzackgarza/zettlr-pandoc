/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Heading fold ranges
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A heading folds its section: the text up to the next
 *                  heading of the same or a higher level, or to the end of the
 *                  document. The fold service answers from the syntax tree of
 *                  the state that it receives, so the range follows an edit.
 *
 * END HEADER
 */

import { ensureSyntaxTree, foldable } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { strict as assert } from 'assert'
import { markdownFolding } from 'source/common/modules/markdown-editor/code-folding/markdown'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'

const DOC = `# Lattices

Opening text.

## Even lattices

Text on even lattices.

### Root systems

Text on roots.

## Odd lattices

Text on odd lattices.

# Surfaces

Closing text.
`

function parsed (state: EditorState): EditorState {
  assert.notEqual(ensureSyntaxTree(state, state.doc.length, 60_000), null, 'the document must parse')
  return state.update({}).state
}

/** The text that the heading line with `heading` folds away, or null when the line does not fold. */
function foldedText (state: EditorState, heading: string): string|null {
  const position = state.sliceDoc().indexOf(heading)
  assert.notEqual(position, -1, `the document must contain ${heading}`)
  const line = state.doc.lineAt(position)
  const range = foldable(state, line.from, line.to)
  return range === null ? null : state.sliceDoc(range.from, range.to)
}

describe('A heading folds its section', function () {
  const state = parsed(EditorState.create({ doc: DOC, extensions: [ markdownParser(), markdownFolding ] }))

  it('up to the next heading of the same or a higher level', function () {
    assert.equal(
      foldedText(state, '# Lattices'),
      DOC.slice(DOC.indexOf('\n\nOpening'), DOC.indexOf('\n# Surfaces'))
    )
    assert.equal(
      foldedText(state, '## Even lattices'),
      DOC.slice(DOC.indexOf('\n\nText on even'), DOC.indexOf('\n## Odd lattices'))
    )
    assert.equal(
      foldedText(state, '### Root systems'),
      DOC.slice(DOC.indexOf('\n\nText on roots'), DOC.indexOf('\n## Odd lattices'))
    )
  })

  it('up to the end of the document when no such heading follows', function () {
    assert.equal(foldedText(state, '# Surfaces'), '\n\nClosing text.\n')
  })

  it('and not a line of text', function () {
    assert.equal(foldedText(state, 'Opening text.'), null)
  })

  it('up to a heading that an edit puts into the section', function () {
    const position = DOC.indexOf('### Root systems')
    const edited = parsed(state.update({ changes: { from: position, insert: '## Unimodular lattices\n\nNew text.\n\n' } }).state)
    assert.equal(foldedText(edited, '## Even lattices'), '\n\nText on even lattices.\n')
    assert.equal(foldedText(edited, '## Unimodular lattices'), '\n\nNew text.\n\n### Root systems\n\nText on roots.\n')
  })
})

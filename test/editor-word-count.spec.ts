/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor word count tests
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The editor counts a document block by block. These tests
 *                  state that its counts are the counts of the document and
 *                  of a selection, before and after edits.
 *
 * END HEADER
 */

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { strict as assert } from 'assert'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { countDocument, countRange } from 'source/common/modules/markdown-editor/util/word-count'
import { markdownToAST } from 'source/common/modules/markdown-utils'
import { countAll } from 'source/common/util/counter'

const DOC = `---
title: "A title"
keywords:
  - one
---

# First heading

A paragraph with *emphasis*, a [link](https://example.com "and a title") and
a second line with \`code\` in it.

* one item
* another item with **strong words**

::: {.theorem #thm:main}
Every statement of the theorem has words.
:::

| Name  | Value |
|-------|-------|
| alpha | one   |

> A quotation that spans
> two lines.

## Second heading

The last paragraph.
`

function parsed (doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdownParser()] })
  assert.ok(ensureSyntaxTree(state, doc.length, 5000) !== null, 'the syntax tree must be fully parsed')
  return state
}

function afterChange (state: EditorState, from: number, to: number, insert: string): EditorState {
  const next = state.update({ changes: { from, to, insert } }).state
  assert.ok(ensureSyntaxTree(next, next.doc.length, 5000) !== null, 'the syntax tree must be fully parsed')
  return next
}

describe('Editor word count', function () {
  it('counts the words and characters of the document', function () {
    const state = parsed(DOC)
    assert.deepEqual(countDocument(state, 'en'), countAll(markdownToAST(DOC), 'en'))
    assert.ok(countDocument(state, 'en').words > 40)
  })

  it('counts the document that an edit made', function () {
    let state = parsed(DOC)
    countDocument(state, 'en')

    const paragraph = DOC.indexOf('A paragraph')
    state = afterChange(state, paragraph, paragraph, 'Three new words. ')
    const item = state.sliceDoc().indexOf('* another item')
    state = afterChange(state, item, item + '* another item'.length, '* item')
    state = afterChange(state, state.doc.length, state.doc.length, '\nOne more paragraph.\n')

    assert.deepEqual(countDocument(state, 'en'), countAll(markdownToAST(state.sliceDoc()), 'en'))
  })

  it('counts a selection', function () {
    const state = parsed(DOC)
    const ranges: Array<[number, number]> = [
      [ 0, DOC.length ],
      [ DOC.indexOf('paragraph'), DOC.indexOf('emphasis') + 3 ],
      [ DOC.indexOf('with *emphasis*'), DOC.indexOf('strong words') + 6 ],
      [ DOC.indexOf('# First heading'), DOC.indexOf('## Second heading') ],
      [ DOC.indexOf('alpha'), DOC.indexOf('two lines') + 3 ],
      [ DOC.indexOf('The last'), DOC.length ]
    ]
    for (const [ from, to ] of ranges) {
      assert.deepEqual(
        countRange(state, 'en', from, to),
        countAll(markdownToAST(DOC), 'en', from, to),
        `the counts of ${from}-${to}`
      )
    }
  })
})

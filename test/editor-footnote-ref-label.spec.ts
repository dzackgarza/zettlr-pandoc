/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Footnote reference-body label parsing
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Pandoc lets a footnote body start on the line after its
 *                  label, indented by four spaces. Both spellings must yield
 *                  the same FootnoteRefLabel node covering "[^id]:", because
 *                  the emphasis renderer hides that node's brackets and colon
 *                  and the body-continuation parser hangs off it.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'

function parse (doc: string): { labels: string[], nodeNames: string[] } {
  const state = EditorState.create({ doc, extensions: [markdownParser()] })
  const tree = ensureSyntaxTree(state, doc.length, 1e9)
  assert.ok(tree !== null, 'parser did not finish')
  const labels: string[] = []
  const nodeNames: string[] = []
  tree.iterate({
    enter (node) {
      nodeNames.push(node.name)
      if (node.name === 'FootnoteRefLabel') {
        labels.push(doc.slice(node.from, node.to))
      }
    }
  })
  return { labels, nodeNames }
}

describe('Footnote reference bodies', function () {
  it('labels a body written on the same line', function () {
    assert.deepEqual(parse('[^3]: By the proof of X.\n').labels, ['[^3]:'])
  })

  it('labels a body written on the following indented line', function () {
    assert.deepEqual(parse('[^1]:\n    More generally, this can be relaxed.\n').labels, ['[^1]:'])
  })

  it('keeps a next-line body inside the footnote, not in a code block', function () {
    const { nodeNames } = parse('[^1]:\n    More generally, this can be relaxed.\n')
    assert.ok(nodeNames.includes('FootnoteRef'), `expected a FootnoteRef node, got ${nodeNames.join(', ')}`)
    assert.ok(!nodeNames.includes('CodeText'), `body parsed as an indented code block: ${nodeNames.join(', ')}`)
  })
})

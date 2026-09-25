/** Pandoc ATX headings are not capped at HTML's h1-h6 range. */

import { strict as assert } from 'assert'
import { foldable, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { markdownFolding } from 'source/common/modules/markdown-editor/code-folding/markdown'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { tocField } from 'source/common/modules/markdown-editor/plugins/toc-field'
import { markdownToAST } from 'source/common/modules/markdown-utils'
import { nodeToHTML } from 'source/common/modules/markdown-utils/markdown-to-html'

describe('Pandoc deep ATX headings', function () {
  it('parses every ATX level with one heading node and exact HeaderMark width', function () {
    for (const level of [ 1, 2, 6, 7, 8, 10, 20 ]) {
      const source = `${'#'.repeat(level)} Type $E$`
      const state = EditorState.create({ doc: source, extensions: [ markdownParser() ] })
      const heading = syntaxTree(state).topNode.firstChild
      assert.ok(heading !== null)
      assert.equal(heading.name, 'ATXHeading')
      const mark = heading.getChild('HeaderMark')
      assert.ok(mark !== null)
      assert.equal(mark.to - mark.from, level)
    }
  })

  it('keeps the semantic heading level in the Markdown AST', function () {
    const ast = markdownToAST('####### Type $E$')
    assert.equal(ast.type, 'Document')
    const heading = ast.children[0]
    assert.equal(heading.type, 'Heading')
    if (heading.type !== 'Heading') throw new Error('expected heading AST node')
    assert.equal(heading.name, 'ATXHeading')
    assert.equal(heading.level, 7)
    assert.equal(heading.content, 'Type $E$')
  })

  it('includes arbitrary Pandoc heading levels in the editor table of contents', function () {
    const source = `# Top

####### Type $E$

######## Deeper

## Back to level two`
    const state = EditorState.create({
      doc: source,
      extensions: [ markdownParser(), tocField ]
    })
    const toc = state.field(tocField)
    assert.deepStrictEqual(toc.map(entry => entry.level), [ 1, 7, 8, 2 ])
    assert.deepStrictEqual(toc.map(entry => entry.text), [
      'Top', 'Type $E$', 'Deeper', 'Back to level two'
    ])
  })

  it('keeps Setext headings in the same table-of-contents model', function () {
    const source = `Title
=====

Subtitle
--------`
    const state = EditorState.create({
      doc: source,
      extensions: [ markdownParser(), tocField ]
    })
    const toc = state.field(tocField)
    assert.deepStrictEqual(toc.map(entry => entry.level), [ 1, 2 ])
    assert.deepStrictEqual(toc.map(entry => entry.text), [ 'Title', 'Subtitle' ])
  })

  it('uses Pandoc-compatible HTML for heading levels beyond h6', function () {
    const ast = markdownToAST('####### Type')
    assert.equal(ast.type, 'Document')
    const heading = ast.children[0]
    assert.equal(heading.type, 'Heading')
    assert.equal(
      nodeToHTML(heading, { zknLinkFormat: 'link|title', onCitation: () => undefined }),
      '<p class="heading">Type</p>'
    )
  })

  it('folds a deep section through deeper descendants and stops at the next peer', function () {
    const source = `# Top

####### Deep
alpha

######## Deeper
beta

####### Peer
gamma

## Parent peer`
    const state = EditorState.create({
      doc: source,
      extensions: [ markdownParser(), markdownFolding ]
    })
    const line = state.doc.line(3)
    const range = foldable(state, line.from, line.to)
    assert.ok(range !== null)
    assert.equal(range.from, line.to)
    assert.equal(range.to, source.indexOf('####### Peer') - 1)
  })
})

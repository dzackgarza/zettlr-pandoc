import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { divModelFromNode } from 'source/common/pandoc-util/pandoc-div-model'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { tocField } from 'source/common/modules/markdown-editor/plugins/toc-field'

describe('Quarto semantic authoring', function () {
  it('preserves theorem aliases and complete identifiers in the editor and reference index', function () {
    const source = '::: {.prp #prp-linear.map:extension}\nA linear map extends to a basis.\n:::\n\nSee @prp-linear.map:extension.'
    const state = EditorState.create({ doc: source, extensions: [markdownParser()] })
    const tree = ensureSyntaxTree(state, source.length, 5000)
    assert.ok(tree)
    const node = tree.topNode.getChild('PandocDiv')
    assert.ok(node)
    const model = divModelFromNode(state.doc, node)
    assert.ok(model)
    assert.equal(model.family, 'result')
    assert.equal(model.label, 'Proposition')
    assert.equal(model.id, 'prp-linear.map:extension')
    const snapshot = extractReferences('/workspace/linear.qmd', source)
    assert.deepEqual(snapshot.definitions.map(d => [d.key, d.family]), [['prp-linear.map:extension', 'prop']])
    assert.deepEqual(snapshot.occurrences.map(o => [o.key, o.family]), [['prp-linear.map:extension', 'prop']])
  })

  it('keeps proof aliases unnumbered while recognizing their semantic presentation', function () {
    for (const divClass of ['prf', 'sol']) {
      const source = `::: {.${divClass} #thm-proof}\nExtend a basis and apply linearity.\n:::`
      const state = EditorState.create({ doc: source, extensions: [markdownParser()] })
      const tree = ensureSyntaxTree(state, source.length, 5000)
      assert.ok(tree)
      const node = tree.topNode.getChild('PandocDiv')
      assert.ok(node)
      assert.equal(divModelFromNode(state.doc, node)?.family, 'proof')
      assert.deepEqual(extractReferences('/workspace/proof.qmd', source).definitions, [])
    }
  })

  it('uses the authored heading ID when attributes contain quoted hashes and whitespace', function () {
    const source = '## Linear maps {title="a #quoted value"\t#sec-linear.maps:extension}'
    const state = EditorState.create({ doc: source, extensions: [markdownParser(), tocField] })
    assert.equal(state.field(tocField)[0].id, 'sec-linear.maps:extension')
    assert.deepEqual(extractReferences('/workspace/linear.qmd', source).definitions.map(d => d.key), ['sec-linear.maps:extension'])
  })
})

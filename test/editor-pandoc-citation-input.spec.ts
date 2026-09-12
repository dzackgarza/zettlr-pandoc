import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import markdownParser from '../source/common/modules/markdown-editor/parser/markdown-parser'
import { extractCitationNodes, nodeToCiteItem } from '../source/common/modules/markdown-editor/parser/citation-parser'

describe('Editable Pandoc citation input', () => {
  it('preserves braced and Unicode identifiers in citation clusters', () => {
    const source = 'Compare [@{field;notes}; @αβ, p. 23].'
    const state = EditorState.create({ doc: source, extensions: [markdownParser()] })
    const citations = extractCitationNodes(state).map(node => nodeToCiteItem(node, source))
    assert.deepEqual(citations.flatMap(citation => citation.items.map(item => item.id)), ['field;notes', 'αβ'])
    assert.equal(citations[0].items[1].locator, '23')
    assert.equal(source.slice(citations[0].from, citations[0].to), '[@{field;notes}; @αβ, p. 23]')
  })

  it('keeps an unfinished bracket cluster editable without exceeding its source', () => {
    const source = 'Compare [@alpha; unfinished'
    const state = EditorState.create({ doc: source, extensions: [markdownParser()] })
    const citations = extractCitationNodes(state).map(node => nodeToCiteItem(node, source))
    assert.deepEqual(citations.map(citation => citation.source), ['@alpha'])
    assert.equal(citations[0].to, source.indexOf(';'))
  })
})

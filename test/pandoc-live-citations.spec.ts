import { strict as assert } from 'assert'
import { extractPandocCitations } from '../source/app/service-providers/references/pandoc-citations'

describe('Pandoc live citation extraction', () => {
  it('publishes exact source ranges and CSL items from a document with code and repeated keys', async () => {
    const source = '---\ntitle: "[@metadata]"\n---\n\n`[@code]`\n\nCompare [see @{field;notes}, pp. 23-25; -@αβ].\n\n@αβ [chap. 7] explains the result.'
    const citations = await extractPandocCitations(source)
    assert.deepEqual(citations.map(citation => citation.source), ['[see @{field;notes}, pp. 23-25; -@αβ]', '@αβ [chap. 7]'])
    assert.deepEqual(citations.map(citation => source.slice(citation.from, citation.to)), citations.map(citation => citation.source))
    assert.deepEqual(citations.map(citation => citation.composite), [false, true])
    assert.deepEqual(citations[0].items.map(item => item.id), ['field;notes', 'αβ'])
    assert.equal(citations[0].items[0].prefix, 'see')
    assert.equal(citations[0].items[0].locator, '23-25')
    assert.equal(citations[0].items[0].label, 'page')
    assert.equal(citations[0].items[1]['suppress-author'], true)
    assert.equal(citations[1].items[0].label, 'chapter')
    assert.equal(citations[1].items[0].locator, '7')
  })

  it('keeps incomplete input bounded and extracts its valid author-in-text citation', async () => {
    const citations = await extractPandocCitations('Compare [@alpha; unfinished')
    assert.deepEqual(citations.map(citation => citation.source), ['@alpha'])
    assert.equal(citations[0].composite, true)
  })

  it('preserves a prose suffix and leaves invalid braced identifiers as authored text', async () => {
    const citations = await extractPandocCitations('@alpha [see discussion] and [@{field notes}].')
    assert.deepEqual(citations.map(citation => citation.source), ['@alpha [see discussion]'])
    assert.equal(citations[0].items[0].suffix, 'see discussion')
    assert.equal(citations[0].items[0].locator, undefined)
  })

  it('retains punctuation and the complete nested-link suffix range', async () => {
    const source = '[@alpha, see also] and [@alpha, see [link](https://example.com)].'
    const citations = await extractPandocCitations(source)
    assert.deepEqual(citations.map(citation => citation.source), ['[@alpha, see also]', '[@alpha, see [link](https://example.com)]'])
    assert.deepEqual(citations.map(citation => citation.items[0].suffix), [', see also', ', see link'])
  })
})

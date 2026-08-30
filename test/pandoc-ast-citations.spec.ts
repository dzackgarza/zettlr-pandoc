import assert from 'assert'
import { execFileSync } from 'child_process'
import { extractCitationsFromPandocAST } from 'source/common/pandoc-util/pandoc-ast-citations'

describe('Pandoc AST Citation Extractor', () => {
  function getPandocAST (markdown: string): unknown {
    const jsonStr = execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], {
      input: markdown,
      encoding: 'utf8'
    })
    return JSON.parse(jsonStr)
  }

  it('extracts bracketed citations directly from real Pandoc AST', () => {
    const md = 'See [@Lurie2009, p. 23; @Joyal2002] for details.'
    const ast = getPandocAST(md)
    const citations = extractCitationsFromPandocAST(ast, md)

    assert.strictEqual(citations.length, 1)
    assert.strictEqual(citations[0].composite, false)
    assert.strictEqual(citations[0].items.length, 2)
    assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
    assert.strictEqual(citations[0].items[0].suffix, 'p. 23')
    assert.strictEqual(citations[0].items[1].id, 'Joyal2002')
  })

  it('extracts narrative in-text citations directly from real Pandoc AST', () => {
    const md = 'According to @Lurie2009 [chap. 2], we have infinity-categories.'
    const ast = getPandocAST(md)
    const citations = extractCitationsFromPandocAST(ast, md)

    assert.strictEqual(citations.length, 1)
    assert.strictEqual(citations[0].composite, true)
    assert.strictEqual(citations[0].items.length, 1)
    assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
    assert.strictEqual(citations[0].items[0].suffix, 'chap. 2')
    assert.strictEqual(citations[0].items[0].mode, 'AuthorInText')
  })

  it('extracts author-suppressed citations directly from real Pandoc AST', () => {
    const md = 'Proved earlier [-@Joyal2002, sec. 4].'
    const ast = getPandocAST(md)
    const citations = extractCitationsFromPandocAST(ast, md)

    assert.strictEqual(citations.length, 1)
    assert.strictEqual(citations[0].items[0].id, 'Joyal2002')
    assert.strictEqual(citations[0].items[0]['suppress-author'], true)
    assert.strictEqual(citations[0].items[0].mode, 'SuppressAuthor')
  })

  it('extracts complex URI and colon citekeys from real Pandoc AST', () => {
    const md = 'Refer to [@nlab:grothendieck_construction; @arxiv:2104.12345].'
    const ast = getPandocAST(md)
    const citations = extractCitationsFromPandocAST(ast, md)

    assert.strictEqual(citations.length, 1)
    assert.strictEqual(citations[0].items[0].id, 'nlab:grothendieck_construction')
    assert.strictEqual(citations[0].items[1].id, 'arxiv:2104.12345')
  })
})

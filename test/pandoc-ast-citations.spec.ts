import assert from 'assert'
import { execFileSync } from 'child_process'
import { extractCitationsFromPandocAST } from 'source/common/pandoc-util/pandoc-ast-citations'

describe('Pandoc AST Citation Extractor Comprehensive Specification', () => {
  function getPandocAST (markdown: string): unknown {
    const jsonStr = execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], {
      input: markdown,
      encoding: 'utf8'
    })
    return JSON.parse(jsonStr)
  }

  describe('1. Basic Citation Forms and Range Fidelity', () => {
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
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '[@Lurie2009, p. 23; @Joyal2002]')
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
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '@Lurie2009 [chap. 2]')
    })

    it('extracts bare narrative in-text citations without locators', () => {
      const md = 'Work by @Lurie2009 was groundbreaking.'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].composite, true)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[0].items[0].suffix, undefined)
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '@Lurie2009')
    })

    it('extracts author-suppressed citations directly from real Pandoc AST', () => {
      const md = 'Proved earlier [-@Joyal2002, sec. 4].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items[0].id, 'Joyal2002')
      assert.strictEqual(citations[0].items[0]['suppress-author'], true)
      assert.strictEqual(citations[0].items[0].mode, 'SuppressAuthor')
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '[-@Joyal2002, sec. 4]')
    })

    it('extracts complex URI and colon citekeys from real Pandoc AST', () => {
      const md = 'Refer to [@nlab:grothendieck_construction; @arxiv:2104.12345; @doi:10.1000/182].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items.length, 3)
      assert.strictEqual(citations[0].items[0].id, 'nlab:grothendieck_construction')
      assert.strictEqual(citations[0].items[1].id, 'arxiv:2104.12345')
      assert.strictEqual(citations[0].items[2].id, 'doi:10.1000/182')
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '[@nlab:grothendieck_construction; @arxiv:2104.12345; @doi:10.1000/182]')
    })
  })

  describe('2. Multi-Citation Streams on Same Document', () => {
    it('extracts multiple distinct citations on the same line without range drift', () => {
      const md = 'First @Lurie2009, then [@Joyal2002, p. 5], and finally @Simpson2012 [vol. 1].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 3)

      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[0].composite, true)
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '@Lurie2009')

      assert.strictEqual(citations[1].items[0].id, 'Joyal2002')
      assert.strictEqual(citations[1].composite, false)
      assert.strictEqual(md.slice(citations[1].range.from, citations[1].range.to), '[@Joyal2002, p. 5]')

      assert.strictEqual(citations[2].items[0].id, 'Simpson2012')
      assert.strictEqual(citations[2].composite, true)
      assert.strictEqual(md.slice(citations[2].range.from, citations[2].range.to), '@Simpson2012 [vol. 1]')
    })

    it('handles identical citekeys repeated across multiple paragraphs', () => {
      const md = 'Initial reference: [@Lurie2009, chap. 1].\n\nSecond reference: [@Lurie2009, chap. 5].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 2)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[0].items[0].suffix, 'chap. 1')
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '[@Lurie2009, chap. 1]')

      assert.strictEqual(citations[1].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[1].items[0].suffix, 'chap. 5')
      assert.strictEqual(md.slice(citations[1].range.from, citations[1].range.to), '[@Lurie2009, chap. 5]')
    })

    it('extracts multiple bracketed citations', () => {
      const md = 'Compare [@Lurie2009] and [@Joyal2002].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 2)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[1].items[0].id, 'Joyal2002')
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '[@Lurie2009]')
      assert.strictEqual(md.slice(citations[1].range.from, citations[1].range.to), '[@Joyal2002]')
    })
  })

  describe('3. Structural Markdown Blocks in Pandoc AST', () => {
    it('extracts citations from Markdown headings', () => {
      const md = '## 1. Topoi (following @Lurie2009 and [@Joyal2002])'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 2)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[1].items[0].id, 'Joyal2002')
    })

    it('extracts citations from BlockQuotes', () => {
      const md = '> In the words of @Mac98 [p. 15], categories abound. See also [@Lurie2009].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 2)
      assert.strictEqual(citations[0].items[0].id, 'Mac98')
      assert.strictEqual(citations[1].items[0].id, 'Lurie2009')
    })

    it('extracts citations from BulletLists and OrderedLists', () => {
      const md = '- Item 1: [@Lurie2009]\n- Item 2: @Joyal2002\n\n1. Step one: see [@Simpson2012]'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 3)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[1].items[0].id, 'Joyal2002')
      assert.strictEqual(citations[2].items[0].id, 'Simpson2012')
    })

    it('extracts citations from Pandoc Fenced Divs', () => {
      const md = '::: {#def-test .theorem}\nFollowing @Lurie2009 [Def. 1.1.1], an infinity-category is a simplicial set.\n:::'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[0].items[0].suffix, 'Def. 1.1.1')
    })

    it('extracts citations from Table cells', () => {
      const md = '| Author | Reference |\n|---|---|\n| Lurie | [@Lurie2009] |\n| Joyal | @Joyal2002 |'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 2)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[1].items[0].id, 'Joyal2002')
    })

    it('extracts citations from Footnotes', () => {
      const md = 'Here is a statement.[^1]\n\n[^1]: As proven in [@Lurie2009, Theorem 4.2].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[0].items[0].suffix, 'Theorem 4.2')
    })
  })

  describe('4. Adjacent Cross-References and Boundary Cases', () => {
    it('extracts both in-text crossrefs and adjacent bracketed citations from Pandoc AST', () => {
      const md = 'As defined in @def-higher-category [@nlab:grothendieck_construction].'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      // Pandoc parses @def-higher-category [@nlab:grothendieck_construction] as a single composite Cite group
      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items.length, 2)
      assert.strictEqual(citations[0].items[0].id, 'def-higher-category')
      assert.strictEqual(citations[0].items[0].mode, 'AuthorInText')
      assert.strictEqual(citations[0].items[1].id, 'nlab:grothendieck_construction')
      assert.strictEqual(citations[0].items[1].mode, 'NormalCitation')
      assert.strictEqual(md.slice(citations[0].range.from, citations[0].range.to), '@def-higher-category [@nlab:grothendieck_construction]')
    })

    it('extracts citations with formatted prefixes and suffixes', () => {
      const md = '[see *e.g.* @Lurie2009, **Theorem** 3.1]'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items[0].id, 'Lurie2009')
      assert.strictEqual(citations[0].items[0].prefix, 'see e.g.')
      assert.strictEqual(citations[0].items[0].suffix, 'Theorem 3.1')
    })

    it('extracts large 5-item clusters cleanly', () => {
      const md = '[see @a, p. 1; @b, chap. 2; -@c; @d, sec. 4; also @e]'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 1)
      assert.strictEqual(citations[0].items.length, 5)
      assert.strictEqual(citations[0].items[0].id, 'a')
      assert.strictEqual(citations[0].items[0].prefix, 'see')
      assert.strictEqual(citations[0].items[0].suffix, 'p. 1')
      assert.strictEqual(citations[0].items[1].id, 'b')
      assert.strictEqual(citations[0].items[1].suffix, 'chap. 2')
      assert.strictEqual(citations[0].items[2].id, 'c')
      assert.strictEqual(citations[0].items[2]['suppress-author'], true)
      assert.strictEqual(citations[0].items[3].id, 'd')
      assert.strictEqual(citations[0].items[3].suffix, 'sec. 4')
      assert.strictEqual(citations[0].items[4].id, 'e')
      assert.strictEqual(citations[0].items[4].prefix, 'also')
    })
  })

  describe('5. Negative Cases (Zero False Positives)', () => {
    it('produces 0 citations for emails and non-citation symbols', () => {
      const md = 'Contact info@example.com for questions. Also see [1], [a-z], and @ 3pm.'
      const ast = getPandocAST(md)
      const citations = extractCitationsFromPandocAST(ast, md)

      assert.strictEqual(citations.length, 0)
    })
  })
})

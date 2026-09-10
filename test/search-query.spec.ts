/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Search query compilation and matching
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure half of the workspace search: what a query
 *                  compiles to, which files it admits, where it matches,
 *                  how a result row reads, and what one match is replaced
 *                  with.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import {
  compileQuery,
  expandReplacement,
  matchDocument,
  type SearchQuery
} from '../source/app/service-providers/search/util/search-query'

function query (overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { text: 'lattice', matchCase: false, wholeWord: false, regex: false, include: '', exclude: '', ...overrides }
}

function ready (overrides: Partial<SearchQuery> = {}): { pattern: RegExp, includesPath: (path: string) => boolean } {
  const compiled = compileQuery(query(overrides))
  assert.equal(compiled.status, 'ready', `the query compiles: ${JSON.stringify(compiled)}`)
  if (compiled.status !== 'ready') {
    throw new Error('unreachable')
  }
  return compiled
}

describe('the workspace search query', function () {
  it('takes the query as text unless the regular-expression option is on', function () {
    const literal = ready({ text: 'a.c' })
    assert.deepEqual(matchDocument('abc a.c', literal.pattern).map(m => m.range), [ { from: 4, to: 7 } ])

    const expression = ready({ text: 'a.c', regex: true })
    assert.deepEqual(matchDocument('abc a.c', expression.pattern).map(m => m.range), [ { from: 0, to: 3 }, { from: 4, to: 7 } ])
  })

  it('reports an unparsable regular expression instead of throwing', function () {
    const compiled = compileQuery(query({ text: 'a(', regex: true }))
    assert.equal(compiled.status, 'invalid-regex')
  })

  it('treats an empty query as no query, not as an error', function () {
    assert.equal(compileQuery(query({ text: '   ' })).status, 'empty')
  })

  it('matches without regard to case until match case is on', function () {
    assert.equal(matchDocument('Lattice lattice', ready().pattern).length, 2)
    assert.equal(matchDocument('Lattice lattice', ready({ matchCase: true }).pattern).length, 1)
  })

  it('matches inside a word until whole word is on', function () {
    const source = 'lattice lattices'
    assert.equal(matchDocument(source, ready().pattern).length, 2)
    assert.deepEqual(
      matchDocument(source, ready({ wholeWord: true }).pattern).map(m => m.range),
      [ { from: 0, to: 7 } ]
    )
  })

  it('counts the line each match is on, one-based', function () {
    const source = 'lattice\n\nsecond lattice\nthird\nlattice'
    assert.deepEqual(matchDocument(source, ready().pattern).map(m => m.line), [ 1, 3, 5 ])
  })

  it('reads a row as the text before the match, the match, and the rest of its line', function () {
    const source = 'a note about the lattice of forms\nand more'
    const [ match ] = matchDocument(source, ready().pattern)
    assert.deepEqual(match.preview, { before: 'a note about the ', inside: 'lattice', after: ' of forms' })
  })

  it('trims a long line from the left and marks that it was trimmed', function () {
    const source = `${'x'.repeat(80)} lattice tail`
    const [ match ] = matchDocument(source, ready().pattern)
    assert.equal(match.preview.before.startsWith('…'), true, `the row says it was trimmed: ${match.preview.before}`)
    assert.equal(match.preview.before.length, 27, 'twenty-six characters of context and the mark')
    assert.equal(match.preview.inside, 'lattice')
    assert.equal(match.preview.after, ' tail')
  })

  it('admits a file by the include globs and rejects it by the exclude globs', function () {
    const both = ready({ include: '*.md', exclude: 'drafts/**' })
    assert.equal(both.includesPath('foundations/categories.md'), true)
    assert.equal(both.includesPath('foundations/notes.txt'), false, 'the include glob decides the extension')
    assert.equal(both.includesPath('drafts/categories.md'), false, 'the exclude glob wins over the include')

    const anywhere = ready()
    assert.equal(anywhere.includesPath('anything/at/all.bib'), true, 'no glob admits every file')
  })

  it('takes several globs separated by commas', function () {
    const compiled = ready({ include: '*.md, *.bib' })
    assert.equal(compiled.includesPath('a/b.md'), true)
    assert.equal(compiled.includesPath('a/b.bib'), true)
    assert.equal(compiled.includesPath('a/b.txt'), false)
  })

  it('expands capture groups into the replacement', function () {
    const compiled = ready({ text: '(\\w+)oid', regex: true })
    assert.equal(expandReplacement('subgroupoid', compiled.pattern, '$1', false), 'subgroup')
  })

  it('carries the case of the match into the replacement only when asked', function () {
    const compiled = ready({ text: 'lattice' })
    assert.equal(expandReplacement('LATTICE', compiled.pattern, 'poset', true), 'POSET')
    assert.equal(expandReplacement('Lattice', compiled.pattern, 'poset', true), 'Poset')
    assert.equal(expandReplacement('lattice', compiled.pattern, 'Poset', true), 'poset')
    assert.equal(expandReplacement('LATTICE', compiled.pattern, 'poset', false), 'poset')
  })
})

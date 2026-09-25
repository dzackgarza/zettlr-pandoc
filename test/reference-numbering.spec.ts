/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor-local reference numbering tests
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Proves the numbering presented inside Zettlr is stable,
 *                  Project-order aware, family-local, and explicitly
 *                  independent of any export numbering engine.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { referenceDisplayNumbers } from '@common/pandoc-util/reference-numbering'
import type { ReferenceDefinition, Resolution } from '@dts/common/references'

function definition (
  key: string,
  family: ReferenceDefinition['family'],
  documentPath: string,
  from: number
): ReferenceDefinition {
  return {
    key,
    family,
    sourceKind: family === 'thm' || family === 'lem' ? 'theorem-div' : 'crossref-attr',
    documentPath,
    range: { from, to: from + key.length + 1 },
    classes: [],
    title: undefined,
    previewSource: '',
    enclosingSection: undefined,
    sourceHash: 'fixture'
  }
}

function resolutions (...definitions: ReferenceDefinition[]): Map<string, Resolution> {
  return new Map(definitions.map(candidate => [
    candidate.key,
    { status: 'resolved', definition: candidate } as const
  ]))
}

describe('editor-local reference numbering', function () {
  it('uses Project file order, source order, and a separate counter per family', function () {
    const numbers = referenceDisplayNumbers(
      resolutions(
        definition('fig:first', 'fig', '/work/book/chapter-1.md', 10),
        definition('thm:first', 'thm', '/work/book/chapter-1.md', 20),
        definition('fig:second', 'fig', '/work/book/chapter-1.md', 30),
        definition('lem:first', 'lem', '/work/book/chapter-2.md', 10),
        definition('fig:third', 'fig', '/work/book/chapter-2.md', 20)
      ),
      [{ rootPath: '/work/book', files: [ 'chapter-1.md', 'chapter-2.md' ] }]
    )

    assert.equal(numbers.get('fig:first'), '1.1.1')
    assert.equal(numbers.get('thm:first'), '1.1.1')
    assert.equal(numbers.get('fig:second'), '1.1.2')
    assert.equal(numbers.get('lem:first'), '1.2.1')
    assert.equal(numbers.get('fig:third'), '1.2.1')
  })

  it('numbers omitted and standalone documents deterministically without inventing export membership', function () {
    const numbers = referenceDisplayNumbers(
      resolutions(
        definition('fig:listed', 'fig', '/work/book/listed.md', 10),
        definition('fig:omitted-b', 'fig', '/work/book/z-omitted.md', 10),
        definition('fig:omitted-a', 'fig', '/work/book/a-omitted.md', 10),
        definition('fig:standalone-b', 'fig', '/notes/z.md', 10),
        definition('fig:standalone-a', 'fig', '/notes/a.md', 10)
      ),
      [{ rootPath: '/work/book', files: [ 'listed.md' ] }]
    )

    assert.equal(numbers.get('fig:listed'), '1.1.1')
    assert.equal(numbers.get('fig:omitted-a'), '1.2.1')
    assert.equal(numbers.get('fig:omitted-b'), '1.3.1')
    assert.equal(numbers.get('fig:standalone-a'), '2.1.1')
    assert.equal(numbers.get('fig:standalone-b'), '2.2.1')
  })

  it('does not assign a display number to ambiguous duplicate keys', function () {
    const duplicate: Resolution = {
      status: 'duplicate',
      definitions: [
        definition('thm:duplicate', 'thm', '/work/a.md', 1),
        definition('thm:duplicate', 'thm', '/work/b.md', 1)
      ]
    }
    const numbers = referenceDisplayNumbers(new Map([['thm:duplicate', duplicate]]))
    assert.equal(numbers.has('thm:duplicate'), false)
  })
})

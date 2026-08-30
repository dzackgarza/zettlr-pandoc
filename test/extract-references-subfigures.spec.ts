/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Subfigure/wrapping crossref extraction specs (issue #1, review A1 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks pandoc-crossref's wrapping/subfigure forms into the
 *                  extraction contract: a fenced div whose OWN id bears a
 *                  supported crossref family prefix (`::: {#fig:group}`
 *                  around subfigure images, `::: {#lst:key}` around a
 *                  captioned listing) defines a reference target, and the
 *                  nested per-image ids stay definitions too. The contract
 *                  names these forms explicitly ("including supported
 *                  wrapping/subfigure forms"); until now the extractor
 *                  dropped every non-theorem-classed div id.
 *
 *                  The fixture (Subfigure_Gallery.md) is covered by the
 *                  Pandoc AST oracle in
 *                  test/extract-references-pandoc-oracle.spec.ts, which
 *                  proves the div ids exist as Pandoc Attr identifiers.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'

// The gallery lives OUTSIDE reference-workspace: the rename-atomicity spec
// pins that directory's exact listing as its no-debris oracle.
const FIXTURE_PATH = path.join('test', 'fixtures', 'subfigure-gallery', 'Subfigure_Gallery.md')

describe('Subfigure/wrapping crossref extraction (review A1)', function () {
  const source = readFileSync(FIXTURE_PATH, 'utf-8')
  const snapshot = extractReferences(FIXTURE_PATH, source)

  it('extracts the subfigure group div id as a crossref definition with the group caption', function () {
    const group = snapshot.definitions.find(definition => definition.key === 'fig:coble-panels')
    assert.ok(group !== undefined, 'the wrapping div id #fig:coble-panels must define a reference target')
    assert.strictEqual(group.family, 'fig')
    assert.strictEqual(group.sourceKind, 'crossref-attr')

    // The range spans exactly the authored id token including its '#' sigil.
    const idToken = '#fig:coble-panels'
    const expectedFrom = source.indexOf(idToken)
    assert.ok(expectedFrom >= 0, 'the fixture must author the group id token')
    assert.deepStrictEqual(group.range, { from: expectedFrom, to: expectedFrom + idToken.length })

    // pandoc-crossref subfigure semantics: the trailing caption paragraph
    // titles the group.
    assert.strictEqual(group.title, 'Semistable degenerations of a Coble surface.')
  })

  it('keeps the nested subfigure image ids as their own definitions', function () {
    const left = snapshot.definitions.find(definition => definition.key === 'fig:coble-left')
    const right = snapshot.definitions.find(definition => definition.key === 'fig:coble-right')
    assert.ok(left !== undefined && right !== undefined, 'both nested subfigure ids must stay definitions')
    assert.strictEqual(left.title, 'Left: nodal degeneration')
    assert.strictEqual(right.title, 'Right: cuspidal degeneration')
  })

  it('extracts the wrapping listing div id with its caption paragraph title', function () {
    const listing = snapshot.definitions.find(definition => definition.key === 'lst:lattice-scan')
    assert.ok(listing !== undefined, 'the wrapping div id #lst:lattice-scan must define a reference target')
    assert.strictEqual(listing.family, 'lst')
    assert.strictEqual(listing.sourceKind, 'crossref-attr')
    assert.strictEqual(listing.title, 'Enumerating isotropic vectors in the Coble lattice.')
    assert.strictEqual(listing.enclosingSection, 'Lattice enumeration')
  })

  it('extracts exactly the five supported fixture definitions in document order', function () {
    assert.deepStrictEqual(
      snapshot.definitions.map(definition => definition.key),
      [
        'fig:coble-panels',
        'fig:coble-left',
        'fig:coble-right',
        'sec:lattice-enumeration',
        'lst:lattice-scan'
      ]
    )
  })

  it('resolves an authored @fig:group occurrence end-to-end against the div definition', function () {
    const occurrence = snapshot.occurrences.find(candidate => candidate.key === 'fig:coble-panels')
    assert.ok(occurrence !== undefined, 'the fixture must cite the subfigure group')

    const resolutions = resolveWorkspace([snapshot])
    const resolution = resolutions.get('fig:coble-panels')
    assert.ok(resolution !== undefined, 'the group key must resolve in the workspace')
    assert.strictEqual(resolution.status, 'resolved')
    assert.strictEqual(
      resolution.status === 'resolved' ? resolution.definition.range.from : undefined,
      source.indexOf('#fig:coble-panels'),
      'the resolution must land on the div id token, not on a nested image'
    )
  })

  it('never extracts unsupported families from div ids', function () {
    const nearMiss = [
      '::: {#table:wrong-prefix}',
      'An unsupported family defines nothing.',
      ':::',
      ''
    ].join('\n')
    const nearMissSnapshot = extractReferences('/near-miss.md', nearMiss)
    assert.deepStrictEqual(nearMissSnapshot.definitions, [])
  })
})


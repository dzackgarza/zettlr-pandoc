/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Replace plan tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure replace plan: the edits that replace the spans a
 *                  search found, the text they produce, and the inverse that
 *                  restores the source, including several spans in one
 *                  document, spans that overlap, and a span outside the text.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { planDocumentReplace } from 'source/app/service-providers/search/util/replace-plan'

const PATH = '/notes/sage.md'
const SOURCE = '# Sage\n\nCompute the maximal subgroupoid with Sage.\n\nEvery subgroupoid here is finite.\n'

function spansOf (needle: string, text: string): Array<{ from: number, to: number }> {
  const spans: Array<{ from: number, to: number }> = []
  let index = text.indexOf(needle)
  while (index >= 0) {
    spans.push({ from: index, to: index + needle.length })
    index = text.indexOf(needle, index + 1)
  }
  return spans
}

describe('planDocumentReplace', function () {
  it('replaces every span of a document and produces the inverse that restores it', function () {
    const plan = planDocumentReplace(PATH, SOURCE, spansOf('subgroupoid', SOURCE), 'subcategory')
    assert.equal(plan.target, '# Sage\n\nCompute the maximal subcategory with Sage.\n\nEvery subcategory here is finite.\n')
    assert.equal(plan.edits.length, 2)
    assert.deepEqual(plan.edits.map(edit => edit.insert), [ 'subcategory', 'subcategory' ])
    // The inverse addresses the target's coordinates and carries the original words.
    assert.deepEqual(plan.inverse.map(edit => edit.insert), [ 'subgroupoid', 'subgroupoid' ])
    assert.equal(plan.inverse[0].range.from, plan.target.indexOf('subcategory'))
    assert.equal(plan.inverse[0].range.to, plan.target.indexOf('subcategory') + 'subcategory'.length)
    const restored = plan.inverse.reduceRight((text, edit) => text.slice(0, edit.range.from) + edit.insert + text.slice(edit.range.to), plan.target)
    assert.equal(restored, SOURCE)
  })

  it('replaces a span with a longer and with an empty insertion, keeping the rest of the line', function () {
    const longer = planDocumentReplace(PATH, SOURCE, spansOf('Sage', SOURCE), 'SageMath')
    assert.equal(longer.target, '# SageMath\n\nCompute the maximal subgroupoid with SageMath.\n\nEvery subgroupoid here is finite.\n')
    const removed = planDocumentReplace(PATH, SOURCE, spansOf(' with Sage', SOURCE), '')
    assert.equal(removed.target, '# Sage\n\nCompute the maximal subgroupoid.\n\nEvery subgroupoid here is finite.\n')
  })

  it('collapses overlapping and duplicate spans to one edit, so nothing is replaced twice', function () {
    const first = SOURCE.indexOf('maximal subgroupoid')
    const spans = [
      { from: first, to: first + 'maximal'.length },
      { from: first + 'maxi'.length, to: first + 'maximal subgroupoid'.length },
      { from: first, to: first + 'maximal'.length }
    ]
    const plan = planDocumentReplace(PATH, SOURCE, spans, 'largest subcategory')
    assert.equal(plan.edits.length, 1)
    assert.equal(plan.target, '# Sage\n\nCompute the largest subcategory with Sage.\n\nEvery subgroupoid here is finite.\n')
  })

  it('refuses a span outside the document', function () {
    assert.throws(() => planDocumentReplace(PATH, SOURCE, [{ from: 10, to: SOURCE.length + 5 }], 'x'), RangeError)
  })
})

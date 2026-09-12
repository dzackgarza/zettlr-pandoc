/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Div-class registry relation (issue #5, B23)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     SEMANTIC_DIV_CLASSES (pandoc-div-model.ts) derives its
 *                  referenceable half from THEOREM_FAMILY_METADATA, so a
 *                  referenceable class can no longer be missing a semantic
 *                  family. What derivation does NOT settle is which family it
 *                  gets: reference-lint warns on every labeled proof-family
 *                  div, so a referenceable class mapped to the proof family
 *                  would make that warning contradict the completion surface
 *                  offering the same class as a label target.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { classifyDiv } from 'source/common/pandoc-util/pandoc-div-model'
import { REFERENCEABLE_DIV_CLASSES, THEOREM_CLASS_TO_PREFIX } from 'source/common/util/pandoc-quick-reference'

describe('Div-class registry relation (issue #5, B23)', function () {
  it('no referenceable div class belongs to the proof family', function () {
    const proofFamilyReferenceable = REFERENCEABLE_DIV_CLASSES
      .filter(divClass => classifyDiv([divClass]).family === 'proof')
    assert.deepEqual(
      proofFamilyReferenceable,
      [],
      'proof-like divs are deliberately unreferenceable (THEOREM_DIV_PREFIXES contract)'
    )
  })

  it('classifies a div by its label prefix exactly as by the equivalent class', function () {
    // The two authored spellings of one theorem kind — Quarto's classless
    // `::: {#def-core}` and pandoc-crossref's `::: {.definition}` — must not
    // present differently.
    for (const divClass of REFERENCEABLE_DIV_CLASSES) {
      const byClass = classifyDiv([divClass])
      const byLabel = classifyDiv([], `${labelPrefixOf(divClass)}-core`)
      assert.deepEqual(byLabel, byClass, `${divClass} presents differently when authored as a label`)
    }
  })
})

function labelPrefixOf (divClass: string): string {
  const prefix = THEOREM_CLASS_TO_PREFIX[divClass]
  assert.ok(prefix !== undefined, `${divClass} has no theorem-family prefix`)
  return prefix
}

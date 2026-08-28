/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Div-class registry cross-derivation canary (issue #5, B23)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Pins the intended relation between the two independently
 *                  authored div-class registries:
 *
 *                  - SEMANTIC_DIV_CLASSES (pandoc-div-model.ts) maps every
 *                    editor-styled fenced-div class to its semantic family;
 *                    classifyDiv() renders anything outside it as 'generic'.
 *                  - REFERENCEABLE_DIV_CLASSES (pandoc-quick-reference.ts,
 *                    derived from THEOREM_DIV_PREFIXES) names the classes a
 *                    `#prefix:key` label may target; proof-like divs are
 *                    deliberately absent (unnumbered, unreferenceable).
 *
 *                  The consumers require, and this spec locks:
 *
 *                  1. REFERENCEABLE ⊆ SEMANTIC: a referenceable div must
 *                     never classify as 'generic' — the editor styles, chips,
 *                     and lint prefix guidance all assume a semantic family
 *                     exists for every referenceable class.
 *                  2. REFERENCEABLE ∩ proof-family = ∅: reference-lint warns
 *                     on ANY labeled proof-family div, which would directly
 *                     contradict the same class being referenceable.
 *
 *                  The registries deliberately do NOT coincide: semantic
 *                  styling covers more classes (e.g. caution, notation) than
 *                  the referenceable set. This spec is the drift canary the
 *                  15-name overlap previously lacked: growing one registry
 *                  into the other's forbidden region now fails a test.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { classifyDiv, SEMANTIC_DIV_CLASSES } from 'source/common/pandoc-util/pandoc-div-model'
import { REFERENCEABLE_DIV_CLASSES } from 'source/common/util/pandoc-quick-reference'

describe('Div-class registry relation (issue #5, B23)', function () {
  it('every referenceable div class carries a semantic family (never generic)', function () {
    const semanticClasses = Object.keys(SEMANTIC_DIV_CLASSES)
    const outsiders = REFERENCEABLE_DIV_CLASSES.filter(divClass => !semanticClasses.includes(divClass))
    assert.deepEqual(
      outsiders,
      [],
      'a referenceable class outside SEMANTIC_DIV_CLASSES would render as a generic div while claiming a typed label'
    )

    // The same claim through the real classifier: no referenceable class may
    // fall through to the generic branch.
    for (const divClass of REFERENCEABLE_DIV_CLASSES) {
      const { family } = classifyDiv([divClass])
      assert.notEqual(family, 'generic', `${divClass} is referenceable and must classify semantically`)
    }
  })

  it('no referenceable div class belongs to the proof family', function () {
    // reference-lint warns on every labeled proof-family div; a class in both
    // registries would make that warning contradict the completion surface.
    const proofFamilyReferenceable = REFERENCEABLE_DIV_CLASSES
      .filter(divClass => SEMANTIC_DIV_CLASSES[divClass] === 'proof')
    assert.deepEqual(
      proofFamilyReferenceable,
      [],
      'proof-like divs are deliberately unreferenceable (THEOREM_DIV_PREFIXES contract)'
    )
  })

  it('the overlap is exactly the referenceable set — a real, nonempty subset', function () {
    // Guard against vacuous passes: the subset relation above must be doing
    // work over the actual 15-name overlap, and the registries must remain
    // genuinely distinct (semantic styling is wider than referenceability).
    const semanticClasses = Object.keys(SEMANTIC_DIV_CLASSES)
    const overlap = semanticClasses.filter(divClass => REFERENCEABLE_DIV_CLASSES.includes(divClass))
    assert.deepEqual([...overlap].sort(), [...REFERENCEABLE_DIV_CLASSES].sort())
    assert.equal(overlap.length, 15, 'the locked referenceable registry has exactly 15 classes')
    assert.ok(
      semanticClasses.length > overlap.length,
      'SEMANTIC_DIV_CLASSES intentionally styles classes beyond the referenceable set'
    )
  })
})

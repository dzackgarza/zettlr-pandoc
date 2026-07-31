/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference family display-name authority specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Pins the user-visible type label of every supported
 *                  reference family. referenceFamilyDisplayName() is the
 *                  single authority every reference view labels its rows
 *                  from — the Mod-P search overlay, the @ completion detail
 *                  line, hover tooltips, reference chips, and the label
 *                  dialog — so these strings ARE the words the user reads.
 *
 *                  The enumeration below is deliberately hand-written while
 *                  the implementation derives its table from the crossref
 *                  and theorem registries: a family added to either registry
 *                  therefore fails this spec until its user-visible name is
 *                  decided here, instead of reaching a view unnamed.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { REFERENCE_FAMILIES, referenceFamilyDisplayName } from 'source/types/common/references'

/** The user-visible type label of every supported family, in registry order. */
const EXPECTED_DISPLAY_NAMES: Array<[string, string]> = [
  [ 'fig', 'Figure' ],
  [ 'tbl', 'Table' ],
  [ 'eq', 'Equation' ],
  [ 'sec', 'Section' ],
  [ 'lst', 'Listing' ],
  [ 'thm', 'Theorem' ],
  [ 'lem', 'Lemma' ],
  [ 'prop', 'Proposition' ],
  [ 'cor', 'Corollary' ],
  [ 'def', 'Definition' ],
  [ 'rmk', 'Remark' ],
  [ 'ex', 'Example' ],
  [ 'conj', 'Conjecture' ],
  [ 'clm', 'Claim' ],
  [ 'obs', 'Observation' ],
  [ 'qst', 'Question' ],
  [ 'prob', 'Problem' ],
  [ 'ass', 'Assumption' ],
  [ 'warn', 'Warning' ],
  [ 'exr', 'Exercise' ],
]

describe('Reference family display names', function () {
  it('names every supported family with the word the user reads', function () {
    assert.deepEqual(
      REFERENCE_FAMILIES.map(family => [ family, referenceFamilyDisplayName(family) ]),
      EXPECTED_DISPLAY_NAMES,
      'every registered family must carry its decided display name; a family added to the crossref or theorem registry must be named here before it can reach a reference view'
    )
  })
})

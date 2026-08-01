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
 *                  Family identity and the rendered word are authored together
 *                  in the two metadata registries. This spec proves the public
 *                  family sequence and accessor preserve that complete metadata
 *                  without a second table that must be updated on expansion.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import {
  PANDOC_CROSS_REFERENCE_EXAMPLES,
  THEOREM_FAMILY_METADATA
} from 'source/common/util/pandoc-quick-reference'
import { REFERENCE_FAMILIES, referenceFamilyDisplayName } from 'source/types/common/references'

const AUTHORED_FAMILY_DISPLAYS = [
  ...PANDOC_CROSS_REFERENCE_EXAMPLES.map(metadata => ({
    family: metadata.prefix,
    displayName: metadata.displayName
  })),
  ...THEOREM_FAMILY_METADATA.map(metadata => ({
    family: metadata.prefix,
    displayName: metadata.displayName
  }))
]

describe('Reference family display names', function () {
  it('preserves every authored family/display pair through the public authority', function () {
    assert.deepEqual(
      REFERENCE_FAMILIES.map(family => ({
        family,
        displayName: referenceFamilyDisplayName(family)
      })),
      AUTHORED_FAMILY_DISPLAYS,
      'the public family model must preserve every identity/display pair from the metadata authorities'
    )
  })
})

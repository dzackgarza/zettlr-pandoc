/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Quick-help reference-authoring content specs (issue #1, Phase 8 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the reference-authoring documentation contract of
 *                  the in-app Pandoc quick help. The editor now ships
 *                  combined @ completion, hover target previews, Mod-P
 *                  definition search, Mod-Click navigation with Back/Forward
 *                  history, workspace rename, and Project-membership
 *                  warnings — so PandocQuickHelp.vue's footer claim that
 *                  cross-reference autocomplete and target previews "are not
 *                  currently available" and its fig/tbl/eq/sec-only
 *                  convention note are FALSE. Following the established
 *                  pandoc-quick-help.spec.ts harness, the CONTENT lives in
 *                  the shared data module
 *                  (source/common/util/pandoc-quick-reference.ts — "keep
 *                  cross-reference prefixes here so the editor renderer and
 *                  the help surface cannot silently drift apart") and is
 *                  asserted there; the SFC assertions below check the copy
 *                  the template authors directly (the unit harness cannot
 *                  mount SFCs — the capture-pandoc-help recipe owns rendered
 *                  proof).
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import {
  PANDOC_REFERENCE_AUTHORING_TOPICS,
  THEOREM_DIV_EXAMPLES,
  THEOREM_FAMILY_METADATA
} from 'source/common/util/pandoc-quick-reference'

const HELP_COMPONENT_PATH = path.join('source', 'win-main', 'PandocQuickHelp.vue')

describe('Quick-help reference authoring content (issue #1 Phase 8)', function () {
  it('documents every shipped reference-authoring capability', function () {
    assert.deepEqual(
      PANDOC_REFERENCE_AUTHORING_TOPICS.map(topic => topic.kind),
      [
        'completion',
        'hover-preview',
        'definition-search',
        'navigation',
        'rename',
        'project-warnings'
      ],
      'the help must document exactly the shipped authoring capabilities: combined completion, hover previews, Mod-P search, navigation, rename, and Project warnings'
    )

    const byKind = new Map(PANDOC_REFERENCE_AUTHORING_TOPICS.map(topic => [ topic.kind, topic ]))
    assert.equal(
      byKind.get('completion')?.syntax,
      '@',
      'the completion topic must name the @ trigger of the combined citation/label surface'
    )
    assert.equal(
      byKind.get('definition-search')?.syntax,
      'Mod-P',
      'the definition-search topic must name the Mod-P shortcut'
    )
    assert.equal(
      byKind.get('navigation')?.syntax,
      'Mod-Click',
      'the navigation topic must name the Mod-Click follow gesture'
    )
  })

  it('exposes an exact fenced-div example for every one of the 15 theorem prefixes', function () {
    const expected = THEOREM_FAMILY_METADATA.map(metadata => ({
      prefix: metadata.prefix,
      divClass: metadata.divClass,
      label: `::: {.${metadata.divClass} #${metadata.prefix}:key}`,
      reference: `@${metadata.prefix}:key`,
    }))

    assert.deepEqual(
      THEOREM_DIV_EXAMPLES,
      expected,
      'the help must expose the complete authored syntax for every registered theorem family'
    )
  })

  it('the help component drops the stale not-currently-available copy', function () {
    const source = readFileSync(HELP_COMPONENT_PATH, 'utf-8')
    assert.equal(
      source.includes('not currently available'),
      false,
      'completion and target previews SHIPPED: the footer claim that they "are not currently available" is false and must go'
    )
    assert.equal(
      source.includes('fig:, tbl:, eq:, and sec:'),
      false,
      'the convention note may no longer claim a fig/tbl/eq/sec-only prefix set: lst and the 15 theorem prefixes are supported'
    )
  })

  it('the help component consumes the shared reference-authoring content', function () {
    // The drift-lock contract of pandoc-quick-reference.ts: the help surface
    // renders the shared registries, never a parallel hand-authored copy.
    const source = readFileSync(HELP_COMPONENT_PATH, 'utf-8')
    assert.equal(
      source.includes('PANDOC_REFERENCE_AUTHORING_TOPICS'),
      true,
      'the help must render the shared authoring-topic registry'
    )
    assert.equal(
      source.includes('THEOREM_DIV_EXAMPLES'),
      true,
      'the help must render the shared theorem-div example registry'
    )
  })
})

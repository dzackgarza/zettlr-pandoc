/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Searchable quick-help specs (issue #1, review A2 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the US-06 searchable-help contract onto the Pandoc
 *                  quick help: a shared, pure text filter narrows every
 *                  example registry by case-insensitive substring across the
 *                  authored titles, details, syntax, and examples, and the
 *                  help component consumes that shared filter behind a
 *                  dedicated filter input. Following the
 *                  pandoc-quick-help-references.spec.ts harness, the
 *                  filtering CONTENT is asserted on the shared data module
 *                  and the SFC assertions check the template's consumption
 *                  (the unit harness cannot mount SFCs — the
 *                  capture-pandoc-help recipe owns rendered proof).
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import {
  filterHelpEntries,
  PANDOC_CITATION_EXAMPLES,
  PANDOC_CROSS_REFERENCE_EXAMPLES,
  PANDOC_REFERENCE_AUTHORING_TOPICS,
  THEOREM_DIV_EXAMPLES
} from 'source/common/util/pandoc-quick-reference'

const HELP_COMPONENT_PATH = path.join('source', 'win-main', 'PandocQuickHelp.vue')

describe('Searchable Pandoc quick help (review A2)', function () {
  it('narrows the cross-reference examples to the queried object', function () {
    const matches = filterHelpEntries(
      PANDOC_CROSS_REFERENCE_EXAMPLES,
      'tbl',
      example => [ example.kind, example.label, example.reference ]
    )
    assert.deepStrictEqual(
      matches.map(example => example.kind),
      ['table'],
      'only the table example authors the tbl: prefix'
    )
  })

  it('narrows the theorem-div examples across class names and authored syntax', function () {
    const byClass = filterHelpEntries(
      THEOREM_DIV_EXAMPLES,
      'lemma',
      example => [ example.divClass, example.label, example.reference ]
    )
    assert.deepStrictEqual(byClass.map(example => example.prefix), ['lem'])

    const bySyntax = filterHelpEntries(
      THEOREM_DIV_EXAMPLES,
      '#conj:',
      example => [ example.divClass, example.label, example.reference ]
    )
    assert.deepStrictEqual(bySyntax.map(example => example.prefix), ['conj'])
  })

  it('matches case-insensitively across titles and details', function () {
    const matches = filterHelpEntries(
      PANDOC_REFERENCE_AUTHORING_TOPICS,
      'MOD-P',
      topic => [ topic.title, topic.detail, topic.syntax ]
    )
    assert.deepStrictEqual(matches.map(topic => topic.kind), ['definition-search'])
  })

  it('keeps every entry on the empty query', function () {
    assert.deepStrictEqual(
      filterHelpEntries(PANDOC_CITATION_EXAMPLES, '', example => [example.syntax]),
      [...PANDOC_CITATION_EXAMPLES]
    )
  })

  it('drops entries whose parts never contain the query', function () {
    assert.deepStrictEqual(
      filterHelpEntries(PANDOC_CITATION_EXAMPLES, 'no-such-substring', example => [example.syntax]),
      []
    )
  })

  it('the help component consumes the shared filter behind a filter input', function () {
    // The drift-lock convention of pandoc-quick-reference.ts: the component
    // renders the shared registries through the shared filter, never a
    // parallel hand-authored one. Rendered filtering proof rides the
    // capture-pandoc-help recipe.
    const source = readFileSync(HELP_COMPONENT_PATH, 'utf-8')
    assert.equal(source.includes('filterHelpEntries'), true, 'the help must narrow through the shared filter')
    assert.equal(source.includes('data-help-filter'), true, 'the help must expose its text-filter input')
  })
})

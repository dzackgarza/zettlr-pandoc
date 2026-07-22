/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Combined @-symbol Autocomplete
 * CVM-Role:        Autocomplete Plugin
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The combined `@` completion surface of issue #1 (Phase 3):
 *                  one provider that preserves bibliography citation
 *                  completion exactly and appends typed workspace reference
 *                  label entries.
 *
 *                  DELEGATION CONTRACT (locked by
 *                  test/editor-reference-completion.spec.ts):
 *
 *                  - applies(ctx) returns exactly citations.applies(ctx).
 *                    The trigger surface of the `@` completion is
 *                    byte-identical to today's citation provider; contexts
 *                    that do not trigger citation completion today never
 *                    trigger the combined surface either.
 *                  - entries(ctx, query) returns exactly the array elements
 *                    citations.entries(ctx, query) returns — the same
 *                    Completion objects, in the same order, with the same
 *                    apply handler — followed by the appended label entries
 *                    derived from referencesUpdateField.
 *                  - A label entry presents `label = key` and
 *                    `detail = '<Type> — <title>'` (the family display name,
 *                    an em-dash, and the authored title), or the bare family
 *                    display name when no title was authored. Filtering is
 *                    the same case-insensitive substring test over label and
 *                    detail that the citation provider applies.
 *                  - Applying a label entry inserts the bare key text over
 *                    the completion range: it never wraps the insertion in
 *                    brackets and never rewrites the authored `@` or an
 *                    authored bracket cluster.
 *                  - projectStatus never gates, reorders, or restyles label
 *                    entries in Phase 3 (status computation is Phase 7).
 *                  - citations.ts stays UNTOUCHED. The production dispatcher
 *                    swap (replacing `citations` with `atSymbols` in the
 *                    first-match array of autocomplete/index.ts) happens only
 *                    in the green step, once this contract holds.
 *
 * END HEADER
 */

import { StateEffect, StateField } from '@codemirror/state'
import { type ReferenceCompletionEntry } from '@dts/common/references'
import { type AutocompletePlugin } from '.'
import { citekeyUpdateField } from './citations'

/**
 * Use this effect to provide the editor state with a new set of workspace
 * reference label entries (the 'references' completion database).
 */
export const referencesUpdate = StateEffect.define<ReferenceCompletionEntry[]>()

export const referencesUpdateField = StateField.define<ReferenceCompletionEntry[]>({
  create (_state) {
    return []
  },
  update (val, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(referencesUpdate)) {
        return effect.value
      }
    }
    return val
  }
})

/**
 * RED SKELETON (issue #1 Phase 3): the combined surface is not implemented
 * yet. applies() returning false means this provider never matches, so the
 * reference-completion specs fail on their assertions while every existing
 * citation code path stays untouched.
 */
export const atSymbols: AutocompletePlugin = {
  applies () {
    return false
  },
  entries () {
    return []
  },
  fields: [ citekeyUpdateField, referencesUpdateField ]
}

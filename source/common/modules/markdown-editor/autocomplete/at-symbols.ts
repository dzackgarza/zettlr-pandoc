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

import { type Completion } from '@codemirror/autocomplete'
import { StateEffect, StateField } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { type ReferenceCompletionEntry, type ReferenceFamily } from '@dts/common/references'
import { THEOREM_DIV_PREFIXES } from '@common/util/pandoc-quick-reference'
import { type AutocompletePlugin } from '.'
import { citations, citekeyUpdateField } from './citations'

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
 * Display names of the explicit pandoc-crossref label families.
 */
const CROSSREF_DISPLAY: Record<string, string> = {
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  sec: 'Section',
  lst: 'Listing'
}

/**
 * The display name of a reference family, derived from the fixed theorem
 * prefix registry ('thm' -> 'Theorem') or the crossref family map
 * ('fig' -> 'Figure').
 *
 * @param   {ReferenceFamily}  family  The reference family
 *
 * @return  {string}                   The capitalized display name
 */
function familyDisplay (family: ReferenceFamily): string {
  const theoremClass = (THEOREM_DIV_PREFIXES as Record<string, string|undefined>)[family]
  if (theoremClass !== undefined) {
    return theoremClass.charAt(0).toUpperCase() + theoremClass.slice(1)
  }

  return CROSSREF_DISPLAY[family]
}

/**
 * The locked `Type — title` display text of a label entry, or the bare
 * family display name when no title was authored.
 *
 * @param   {ReferenceCompletionEntry}  entry  The label entry
 *
 * @return  {string}                           The detail display text
 */
function labelDetail (entry: ReferenceCompletionEntry): string {
  return entry.title !== undefined
    ? `${familyDisplay(entry.family)} — ${entry.title}`
    : familyDisplay(entry.family)
}

/**
 * Applies a label completion: the bare key text replaces the completion
 * range. This never wraps the insertion in brackets and never rewrites the
 * authored `@` or an authored bracket cluster.
 */
const applyLabel = function (view: EditorView, completion: Completion, from: number, to: number): void {
  const insert = String(completion.label)
  view.dispatch({ changes: [{ from, to, insert }], selection: { anchor: from + insert.length } })
}

/**
 * The combined `@` completion surface: bibliography citation completion,
 * delegated verbatim to the citations provider, followed by the typed
 * workspace reference label entries of the 'references' database.
 * projectStatus never gates, reorders, or restyles label entries in Phase 3.
 */
export const atSymbols: AutocompletePlugin = {
  applies (ctx) {
    // The trigger surface is byte-identical to the citation provider's.
    return citations.applies(ctx)
  },
  entries (ctx, query) {
    query = query.toLowerCase()
    const labelEntries: Completion[] = ctx.state.field(referencesUpdateField)
      .map(entry => ({
        label: entry.key,
        detail: labelDetail(entry),
        apply: applyLabel
      }))
      .filter(entry => {
        // The same case-insensitive substring filter the citation provider
        // applies, over label and detail.
        return entry.label.toLowerCase().includes(query) || entry.detail.toLowerCase().includes(query)
      })

    return citations.entries(ctx, query).concat(labelEntries)
  },
  fields: [ citekeyUpdateField, referencesUpdateField ]
}

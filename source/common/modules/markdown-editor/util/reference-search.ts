/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace reference definition search
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure ranking core behind Mod-P workspace definition
 *                  search (issue #1 Phase 3).
 *
 *                  CONTRACT (locked by test/reference-fzf-search.spec.ts):
 *
 *                  - Ranking is backed by the browser-safe `fzf` npm package
 *                    (import { Fzf } from 'fzf') — no shell fzf process and
 *                    no bespoke fuzzy matcher.
 *                  - The search haystack of a definition is its authored key
 *                    (e.g. 'lem:kodaira:embedding').
 *                  - The empty query reaches every workspace definition,
 *                    including duplicate definitions of the same key.
 *                  - Non-matching definitions are excluded; matching
 *                    definitions are ordered by descending fzf score, so
 *                    consecutive-substring matches rank above scattered
 *                    fuzzy matches.
 *
 * END HEADER
 */

// NOTE: fzf is ESM-only; this must remain a real ESM import. A require()
// call resolves to an empty object at runtime.
import { Fzf } from 'fzf'
import { type ReferenceDefinition } from '@dts/common/references'

/**
 * Ranks the workspace's reference definitions against a fuzzy query.
 *
 * The search haystack of a definition is its authored key. The empty query
 * reaches every workspace definition (including duplicate definitions of the
 * same key); non-empty queries return the fzf matches in descending score
 * order, so consecutive-substring matches rank above scattered fuzzy ones.
 *
 * @param   {ReferenceDefinition[]}  definitions  Every workspace definition
 * @param   {string}                 query        The typed fuzzy query
 *
 * @return  {ReferenceDefinition[]}               The ranked matches
 */
export function searchWorkspaceDefinitions (definitions: ReferenceDefinition[], query: string): ReferenceDefinition[] {
  if (query === '') {
    return [...definitions]
  }

  const fzf = new Fzf(definitions, {
    selector: definition => definition.key
  })

  return fzf.find(query).map(result => result.item)
}

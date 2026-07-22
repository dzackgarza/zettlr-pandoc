/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference Linter
 * CVM-Role:        Linter
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Diagnostics for workspace reference contradictions
 *                  (issue #1 Phase 4), following the md-lint linter()
 *                  archetype (./md-lint.ts). Wiring into
 *                  editor-extension-sets.ts happens in the green step.
 *
 *                  CONTRACT (locked by test/reference-lint.spec.ts):
 *
 *                  - referenceLintSource() is the linter source and is
 *                    exported for direct headless driving. The current
 *                    document's definitions and occurrences come from
 *                    workspaceReferencesField.snapshot; resolutions and the
 *                    citing index come from the same field. While the field
 *                    is null the linter reports nothing.
 *                  - DUPLICATE KEYS: every definition in this document whose
 *                    key resolves to 'duplicate' receives an ERROR at the
 *                    definition's authored id range whose message lists ALL
 *                    definition sites (every documentPath in the
 *                    resolution's definitions), never a silently selected
 *                    subset.
 *                  - MISSING REFERENCES: every occurrence in this document
 *                    whose key resolves to 'missing' receives a WARNING at
 *                    the occurrence's authored range naming the missing key.
 *                    The message MAY offer compatible existing keys as
 *                    replacement candidates, but every family-prefixed key
 *                    it mentions must be either the missing key itself or a
 *                    key actually defined in the workspace — the linter
 *                    never fabricates targets.
 *                  - CLASS/PREFIX MISMATCH: a theorem-div definition whose
 *                    div class and id prefix disagree (e.g. div class
 *                    `lemma` with id `thm:foo`) receives an ERROR at the
 *                    authored id range naming BOTH conflicting values and a
 *                    valid example (e.g. `#lem:foo` per the
 *                    THEOREM_DIV_PREFIXES mapping). The linter never guesses
 *                    which side the author meant and never rewrites either.
 *                  - PROOF-DIV ID: an id attribute on a proof-like div
 *                    (which defines no target) receives an INFO diagnostic
 *                    at the authored id token explaining that proofs are
 *                    unreferenceable.
 *                  - MIXED CLUSTER ADVISORY: a citation cluster mixing
 *                    bibliography keys and supported-family reference keys
 *                    stays raw in the editor and receives a WARNING spanning
 *                    the whole authored cluster.
 *                  - NO AUTO-FIX: no diagnostic ever carries actions of any
 *                    kind.
 *
 *                  RED SKELETON: the source reports no diagnostics, so the
 *                  spec fails on its diagnostic assertions, not on wiring.
 *
 * END HEADER
 */

import { linter, type Diagnostic } from '@codemirror/lint'
import { type EditorView } from '@codemirror/view'

/**
 * The diagnostic source for workspace reference lint: the specs drive this
 * function directly against a real EditorView.
 *
 * @param   {EditorView}  _view  The editor view
 *
 * @return  {Promise<Diagnostic[]>}  The reference diagnostics
 */
export async function referenceLintSource (_view: EditorView): Promise<Diagnostic[]> {
  // RED skeleton (issue #1 Phase 4): no reference diagnostics are produced yet.
  return []
}

export const referenceLint = linter(referenceLintSource)

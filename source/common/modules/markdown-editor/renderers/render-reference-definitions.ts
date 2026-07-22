/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceDefinitionBadgeRenderer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Decorates every reference definition in the current
 *                  document with a subtle label badge and an always-visible
 *                  citing-count badge (issue #1 Phase 4).
 *
 *                  CONTRACT (locked by test/editor-reference-badges.spec.ts):
 *
 *                  - The definition set is exactly
 *                    workspaceReferencesField.snapshot.definitions (the
 *                    current document's live snapshot); while the field is
 *                    null nothing renders and no counts are fabricated.
 *                  - Every definition receives one subtle label badge
 *                    (span.reference-definition-badge with
 *                    data-reference-key) whose text is the authored key, and
 *                    one separate always-visible count badge
 *                    (span.reference-count-badge with data-reference-key and
 *                    data-citing-count), INCLUDING when the count is zero.
 *                  - The citing count of a definition is the number of
 *                    entries in workspaceOccurrences whose key equals the
 *                    definition's key — occurrences across the whole merged
 *                    workspace view, not just this document. The badge text
 *                    is `1 reference` for exactly one citing location and
 *                    `N references` otherwise (including `0 references`).
 *                  - Badges are widget decorations beside the authored
 *                    source: they never replace, hide, or renumber authored
 *                    text, and they never display any computed reference
 *                    number.
 *                  - Clicking a count badge emits the same signal family as
 *                    Mod-P: it dispatches
 *                    openReferenceSearchEffect.of({ key }) so the shared
 *                    overlay opens populated with that definition's workspace
 *                    citing locations. The assertion target is that emitted
 *                    intent (and the badge's own count), never overlay
 *                    internals.
 *
 *                  RED SKELETON: the field provides no decorations yet, so
 *                  the spec fails on its badge assertions, not on wiring.
 *
 * END HEADER
 */

import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState } from '@codemirror/state'

export const renderReferenceDefinitions = StateField.define<DecorationSet>({
  create (_state: EditorState) {
    // RED skeleton (issue #1 Phase 4): no definition badges are rendered yet.
    return Decoration.none
  },
  update (_decorations, _transaction) {
    return Decoration.none
  },
  provide: f => EditorView.decorations.from(f)
})

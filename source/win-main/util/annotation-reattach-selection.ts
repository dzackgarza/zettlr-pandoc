/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reattach-selection resolver
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     S8/I6: the annotations panel's Reattach control only ever
 *                  names an annotation (component-contracts.ts
 *                  EditorCommands.beginAnnotationReattach) — the replacement
 *                  range is whatever the owner has just selected in the
 *                  editor. Extracted out of MainEditor.vue's watcher so the
 *                  decision (a real range, or a refusal because nothing is
 *                  selected) is directly testable against a real
 *                  EditorView, the same way annotate-selection.ts's
 *                  resolveAnnotateSelectionMenuItem is: MainEditor.vue is
 *                  the wiring, this is the rule.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'

export type ReattachSelection =
  | { ok: true, from: number, to: number }
  | { ok: false, reason: 'empty-selection' }

/**
 * The owner's current selection in `view`, as a Reattach replacement range
 * — or a refusal when nothing is selected. Never fabricates a point range:
 * I6 forbids a background guess, and a collapsed cursor is not a range the
 * owner picked.
 */
export function resolveReattachSelection (view: EditorView): ReattachSelection {
  const { from, to } = view.state.selection.main
  if (from === to) {
    return { ok: false, reason: 'empty-selection' }
  }
  return { ok: true, from, to }
}

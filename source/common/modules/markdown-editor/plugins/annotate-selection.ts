/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Selection-anchored annotate command signal
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The "Annotate for AI…" context-menu entry (M6), split
 *                  out of default-context-menu.ts the way
 *                  create-reference-label.ts is: a plain module with no
 *                  dependency on the Electron-backed menu-rendering chain
 *                  (default-menu.ts -> showPopupMenu -> language-tool.ts
 *                  touches ipcRenderer at import time), so
 *                  resolveAnnotateSelectionMenuItem is testable directly
 *                  against a real EditorView under plain Node.
 *
 *                  The composer itself is opened via a plain bubbling DOM
 *                  CustomEvent (ANNOTATE_SELECTION_EVENT) on the view's own
 *                  element, not a CodeMirror StateEffect — MainEditor.vue
 *                  listens for it on the stable pane wrapper, so no relay
 *                  needs wiring into the editor core.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'

/**
 * The command's identity: what a caller checks to know the command fired,
 * as opposed to the menu item's translated label, which a locale change
 * could alter without touching the command's actual identity.
 */
export const ANNOTATE_SELECTION_EVENT = 'zettlr-annotate-selection'

/**
 * Resolves the "Annotate for AI…" menu item at the view's CURRENT
 * selection, or null when there is nothing selected. Callers must check
 * this BEFORE a word-selection fallback can turn an empty selection into a
 * non-empty one — a context click with no selection must never offer this
 * command (M6 structural gate, question 4).
 */
export function resolveAnnotateSelectionMenuItem (view: EditorView): AnyMenuItem | null {
  const selection = view.state.selection.main
  if (selection.from === selection.to) {
    return null
  }
  return {
    label: trans('Annotate for AI…'),
    type: 'normal',
    action () {
      // The element's OWN realm's CustomEvent, not the ambient global one:
      // under jsdom (test/setup.js copies window onto global but a native
      // Node CustomEvent shadows jsdom's own), dispatching an event built
      // from the wrong realm's constructor throws. Production's single
      // window realm makes this the same constructor either way.
      const ownerWindow = view.dom.ownerDocument.defaultView ?? window
      view.dom.dispatchEvent(new ownerWindow.CustomEvent(ANNOTATE_SELECTION_EVENT, {
        bubbles: true,
        detail: { from: selection.from, to: selection.to }
      }))
    }
  }
}

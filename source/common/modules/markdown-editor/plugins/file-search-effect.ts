/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File search effect
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Carries the editor-level quick-file shortcut out of the
 *                  framework-agnostic CodeMirror core. MarkdownEditor relays
 *                  the effect to the main-window shell, which opens the
 *                  command launcher's existing Go to file view.
 *
 * END HEADER
 */

import { StateEffect } from '@codemirror/state'
import { type Command } from '@codemirror/view'

/** Signals that the user requested the workspace quick-file picker. */
export const openFileSearchEffect = StateEffect.define<null>()

/** Dispatches a quick-file request from the editor keymap. */
export const openFileSearch: Command = view => {
  view.dispatch({ effects: openFileSearchEffect.of(null) })
  return true
}

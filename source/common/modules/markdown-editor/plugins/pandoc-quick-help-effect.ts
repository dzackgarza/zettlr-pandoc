/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc quick-help effect
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The in-editor open-the-quick-help signal (issue #1,
 *                  review A2 / US-06). Editor surfaces that link to the
 *                  searchable Pandoc quick help — the combined @-completion
 *                  info panel — dispatch the StateEffect defined here; the
 *                  MarkdownEditor update listener re-emits it as a
 *                  'pandoc-quick-help' event, which MainEditor.vue relays up
 *                  the component tree until App.vue mounts PandocQuickHelp
 *                  (the same surface the Help menu opens over the 'shortcut'
 *                  ipc channel).
 *
 * END HEADER
 */

import { StateEffect } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'

/**
 * Signals that the user requested the Pandoc quick help from inside the
 * editor.
 */
export const openPandocQuickHelpEffect = StateEffect.define<null>()

/**
 * Dispatches the open-quick-help request on the given view.
 *
 * @param   {EditorView}  view  The editor view
 */
export function requestPandocQuickHelp (view: EditorView): void {
  view.dispatch({ effects: openPandocQuickHelpEffect.of(null) })
}

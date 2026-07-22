/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference search effect
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Mod-P workspace reference search signal (issue #1
 *                  Phase 3b). The keymap dispatches the StateEffect defined
 *                  here; the MarkdownEditor update listener re-emits it as a
 *                  'reference-search' event, which MainEditor.vue relays up
 *                  the component tree until App.vue mounts the
 *                  ReferenceSearchOverlay.
 *
 * END HEADER
 */

import { StateEffect } from '@codemirror/state'
import { type Command } from '@codemirror/view'

/**
 * Signals that the user requested the workspace reference search overlay.
 */
export const openReferenceSearchEffect = StateEffect.define<null>()

/**
 * Dispatches the reference search request (bound to Mod-p in the default
 * keymap).
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {boolean}           Always true — the request is always handled
 */
export const openReferenceSearch: Command = view => {
  view.dispatch({ effects: openReferenceSearchEffect.of(null) })
  return true
}

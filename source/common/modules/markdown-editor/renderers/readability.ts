/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Readability toggle
 * CVM-Role:        CodeMirror command
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Switches the editor's readability mode on and off; the
 *                  window's status bar runs it as an editor command.
 *
 * END HEADER
 */

import { type EditorView } from '@codemirror/view'
import { configField, configUpdateEffect } from '../util/configuration'

/** Flips the readability mode of the editor's configuration. */
export function toggleReadability (view: EditorView): boolean {
  const config = view.state.field(configField)
  view.dispatch({ effects: configUpdateEffect.of({ readabilityMode: !config.readabilityMode }) })
  return true
}

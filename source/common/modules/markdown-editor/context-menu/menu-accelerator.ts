/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The keys of the editor context menus
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A context menu of the editor shows the key of each command
 *                  as the command registry gives it: the key that the author
 *                  configured, or the key of the platform (#202).
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import { cmShortcutToElectron } from "source/common/util/shortcuts";
import { type EditorShortcutName, getCustomShortcut } from "../keymaps/shortcuts";
import { configField } from "../util/configuration";

/** The accelerator of an editor command, as the author configured it. */
export function editorMenuAccelerator(
  view: EditorView,
  name: EditorShortcutName,
): string | undefined {
  return cmShortcutToElectron(getCustomShortcut(name, view.state.field(configField).shortcuts));
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CodeMirror Custom Shortcuts
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains functionality to support custom shortcuts.
 *
 * END HEADER
 */

import {
  commandRegistry,
  type EditorCommandId,
  getConfiguredShortcut,
} from "@common/commands/command-registry";
import type { DefaultShortcut } from "source/common/util/shortcuts";

/**
 * An enum of names that are available for custom shortcuts.
 */
export type EditorShortcutName = EditorCommandId;

/**
 * Structure of a custom editor shortcut
 */
export interface CustomEditorShortcut {
  name: EditorShortcutName;
  shortcut: string;
}

/**
 * Default keybindings for all commands. May be empty (in which case there is no
 * default shortcut assigned.) This is used to collect all keybindings at a
 * central place and allow configuration of a subset of them.
 */
export const defaultKeybindings: Record<EditorShortcutName, DefaultShortcut> = Object.fromEntries(
  commandRegistry
    .all()
    .filter((command) => command.scope === "editor")
    .map((command) => [command.id, command.defaultKeybinding]),
);

/**
 * Retrieves a custom shortcut based on the shortcut name, the available map of
 * existing custom shortcuts, and an optional default key. This function returns
 * undefined as a fallback, which means you can use it to retrieve the `key`
 * property for CodeMirror's keyboard commands API.
 *
 * @param   {ShortcutName}            name  The shortcut in question
 * @param   {CustomEditorShortcut[]}  map   The map of available custom shortcuts
 *
 * @return  {string}                        Either a shortcut, or undefined.
 */
export function getCustomShortcut(
  name: EditorShortcutName,
  map: CustomEditorShortcut[],
): string | undefined {
  const candidate = map.find((s) => s.name === name);
  return getConfiguredShortcut(name, {
    editor: candidate === undefined ? {} : { [name]: candidate.shortcut },
    ui: {},
  });
}

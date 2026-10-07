/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Shortcuts Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Generates the shortcut tab from the command registry.
 *
 * END HEADER
 */

import {
  type CommandGroup,
  type CommandId,
  commandRegistry,
  getCommandConflicts,
  getConfiguredShortcut,
  type ShortcutConfig,
} from "@common/commands/command-registry";
import { trans } from "@common/i18n-renderer";
import type { ConfigOptions } from "source/app/service-providers/config/get-config-template.js";
import { PreferencesGroups } from "./_preferences-groups";
import { type PreferencesFieldset } from "./types";

/** Returns commands in the same scope that currently use this command's key. */
export function getConflicts(
  id: CommandId,
  editorMap: Array<{ name: CommandId; shortcut: string }>,
  menuMap: ConfigOptions["shortcuts"]["ui"],
): CommandId[] {
  const editor = Object.fromEntries(editorMap.map(({ name, shortcut }) => [name, shortcut]));
  return getCommandConflicts(id, { editor, ui: menuMap });
}

function groupTitle(group: CommandGroup): string {
  return trans("%s Shortcuts", group);
}

export function getShortcutFields(config: Pick<ConfigOptions, "shortcuts">): PreferencesFieldset[] {
  const shortcuts: ShortcutConfig = config.shortcuts;
  const commands = commandRegistry.all();
  const groups = [...new Set(commands.map((command) => command.group))];
  return groups.map((group) => ({
    title: groupTitle(group),
    infoString: trans("Customize keyboard shortcuts for %s commands.", group.toLowerCase()),
    group: PreferencesGroups.Shortcuts,
    help: undefined,
    fields: commands
      .filter((command) => command.group === group)
      .map((command) => ({
        type: "shortcut" as const,
        label: trans(command.label),
        model: `shortcuts.${command.scope === "editor" ? "editor" : "ui"}.${command.id}`,
        defaultShortcut: getConfiguredShortcut(command.id, { editor: {}, ui: {} }),
        conflicts: getCommandConflicts(command.id, shortcuts).map((id) => {
          const conflict = commandRegistry.get(id);
          return conflict === undefined ? id : trans(conflict.label);
        }),
      })),
  }));
}

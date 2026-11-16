/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        migrateExportItems
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A configuration from before the export items holds the
 *                  export commands of the author in `export.customCommands`
 *                  and the export scripts in `export.scripts`. Both are
 *                  export items (`commands/exporter/export-items.ts`): a
 *                  command is an item without a base, and a script is an
 *                  item whose base is its profile.
 *
 * END HEADER
 */

import type { ConfigOptions } from "./get-config-template";

/** The export settings of a stored configuration that this migration reads and writes. */
export interface StoredExportItems {
  items?: ConfigOptions["export"]["items"];
  customCommands?: Array<{ displayName: string; command: string }>;
  scripts?: Array<{ name: string; profile: string; command: string; extension: string }>;
}

/**
 * Makes `items` of the commands and the scripts of a stored configuration,
 * in place: the commands first, then the scripts, each in its order. A
 * configuration with `items` is past this migration and stays as it is; so
 * does a configuration with neither old setting.
 *
 * @param   {StoredExportItems}  stored  The `export` section of the stored configuration
 */
export function migrateExportItems(stored: StoredExportItems): void {
  if (
    stored.items !== undefined ||
    (stored.customCommands === undefined && stored.scripts === undefined)
  ) {
    return;
  }
  const commands = Array.isArray(stored.customCommands) ? stored.customCommands : [];
  const scripts = Array.isArray(stored.scripts) ? stored.scripts : [];
  stored.items = [
    ...commands.map((command) => ({
      name: command.displayName,
      base: "",
      command: command.command,
      extension: "",
    })),
    ...scripts.map((script) => ({
      name: script.name,
      base: script.profile,
      command: script.command,
      extension: script.extension,
    })),
  ];
  delete stored.customCommands;
  delete stored.scripts;
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The keys of the application menu
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Each key of the application menu is the key of the
 *                  registered command that its item runs, as the author
 *                  configured it (#202). A template states no key itself.
 *
 * END HEADER
 */

import {
  commandAccelerator,
  commandForMenuItem,
  type ShortcutConfig,
} from "@common/commands/command-registry";
import type { MenuItemConstructorOptions } from "electron";

/**
 * The roles to which Electron gives a key of its own on a platform when the
 * item states none. Reference: `lib/browser/api/menu-item-roles.ts` of
 * Electron (`accelerator` of each role).
 */
function rolesWithOwnKey(platform: NodeJS.Platform): ReadonlySet<string> {
  const roles = [
    "close",
    "copy",
    "cut",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
    "undo",
    "redo",
    "forceReload",
    "minimize",
    "reload",
    "resetZoom",
    "zoomIn",
    "zoomOut",
    "togglefullscreen",
    "toggleDevTools",
  ];
  if (platform === "darwin") {
    roles.push("hide", "hideOthers", "quit");
  } else if (platform === "linux") {
    roles.push("quit");
  }
  return new Set(roles.map((role) => role.toLowerCase()));
}

/**
 * The template with the key of each item that runs a registered command.
 * An item that states a key, and an item whose role has a key of its own
 * while its command gives no key, throw: such a key would not follow the
 * configuration, and no conflict check would see it.
 */
export function withRegisteredAccelerators(
  template: readonly MenuItemConstructorOptions[],
  shortcuts: ShortcutConfig,
): MenuItemConstructorOptions[] {
  const ownKeyRoles = rolesWithOwnKey(process.platform);
  const visit = (item: MenuItemConstructorOptions): MenuItemConstructorOptions => {
    if (item.accelerator !== undefined) {
      throw new Error(
        `The menu item "${item.id ?? item.label ?? "?"}" states the key "${String(item.accelerator)}". ` +
          "The key of a menu item is the key of its command in the command registry " +
          "(source/common/commands/command-registry.ts, `menuItems`).",
      );
    }
    const command = item.id === undefined ? undefined : commandForMenuItem(item.id);
    const accelerator = command === undefined ? undefined : commandAccelerator(command, shortcuts);
    if (
      accelerator === undefined &&
      item.role !== undefined &&
      ownKeyRoles.has(item.role.toLowerCase())
    ) {
      throw new Error(
        `The menu item "${item.id ?? item.label ?? "?"}" has the role "${item.role}", to which Electron ` +
          "gives a key of its own, and its command gives no key on this platform. Register the command " +
          "with the item in `menuItems` and a key for this platform.",
      );
    }
    const visited: MenuItemConstructorOptions = Array.isArray(item.submenu)
      ? { ...item, submenu: item.submenu.map(visit) }
      : { ...item };
    if (accelerator !== undefined) {
      visited.accelerator = accelerator;
    }
    return visited;
  };
  return template.map(visit);
}

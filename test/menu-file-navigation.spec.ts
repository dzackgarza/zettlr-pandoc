/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Application-menu file-navigation wiring spec
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the actual Previous file and Next file callbacks
 *                  from both shipped menu templates. The providers supplied
 *                  here implement the builders' explicit capability contract;
 *                  they do not masquerade as application service classes.
 *
 * END HEADER
 */

// biome-ignore-all assist/source/organizeImports: the harness installs the
// electron stand-in at module scope, so it has to load before any module
// that imports electron itself. Sorting these imports breaks the specs.
import { sentMessagesFor } from "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import {
  BrowserWindow,
  type KeyboardEvent,
  MenuItem,
  type MenuItemConstructorOptions,
} from "electron";
import getDarwinMenu from "source/app/service-providers/menu/menu.darwin";
import getWin32Menu from "source/app/service-providers/menu/menu.win32";
import type {
  MenuCommands,
  MenuConfig,
  MenuDocuments,
  MenuLogger,
  MenuRecentDocuments,
  MenuWindows,
} from "source/app/service-providers/menu/menu-dependencies";

Object.defineProperty(globalThis, "__UPDATES_DISABLED__", {
  configurable: true,
  value: "0",
});

type MenuBuilder = typeof getWin32Menu;
type Send = unknown[];

class TestMenuConfig implements MenuConfig {
  get(): { editor: { fontSize: number } };
  get(key: "system.zoomBehavior" | "darkMode" | "fileMeta" | "debug"): unknown;
  get(key?: "system.zoomBehavior" | "darkMode" | "fileMeta" | "debug"): unknown {
    if (key === undefined) {
      return { editor: { fontSize: 14 } };
    }
    return key === "system.zoomBehavior" ? "editor" : false;
  }

  set(_key: "darkMode" | "fileMeta" | "editor.fontSize", _value: boolean | number): void {}
}

function findItem(
  items: MenuItemConstructorOptions[],
  id: string,
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }
    if (Array.isArray(item.submenu)) {
      const found = findItem(item.submenu, id);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function clickMenuItem(
  getMenu: MenuBuilder,
  id: string,
): {
  sent: Send[];
  commandCalls: string[];
  loggedErrors: string[];
} {
  const commandCalls: string[] = [];
  const loggedErrors: string[] = [];
  const logger: MenuLogger = {
    error: (message) => {
      loggedErrors.push(message);
    },
  };
  const config = new TestMenuConfig();
  const recentDocs: MenuRecentDocuments = {
    get: () => [],
    clear: () => {},
  };
  const commands: MenuCommands = {
    run: async (command) => {
      commandCalls.push(command);
      return undefined;
    },
  };
  const windows: MenuWindows = {
    showAboutWindow: () => {},
    showDefaultsWindow: () => {},
    showLogWindow: () => {},
    showPreferences: () => {},
    showTagManager: () => {},
  };
  const documents: MenuDocuments = {
    newWindow: () => {},
    openFile: async () => false,
  };

  const template = getMenu(
    logger,
    config,
    recentDocs,
    commands,
    windows,
    documents,
    () => false,
    () => {},
  );
  const item = findItem(template, id);
  assert.ok(item !== undefined, `the menu must expose ${id}`);
  const click = item.click;
  assert.ok(click !== undefined, `the menu item ${id} must be clickable`);

  const focusedWindow = new BrowserWindow();
  const menuItem = new MenuItem(item);
  const event: KeyboardEvent = { triggeredByAccelerator: true };
  click(menuItem, focusedWindow, event);

  return {
    sent: sentMessagesFor(focusedWindow),
    commandCalls,
    loggedErrors,
  };
}

describe("File ▸ Previous/Next file menu navigation", function () {
  const platforms: Array<[string, MenuBuilder]> = [
    ["win32/linux", getWin32Menu],
    ["darwin", getDarwinMenu],
  ];

  for (const [platform, getMenu] of platforms) {
    it(`${platform}: Previous file moves the focused pane back`, function () {
      assert.deepEqual(clickMenuItem(getMenu, "menu.previous_file"), {
        sent: [["shortcut", "navigate-back"]],
        commandCalls: [],
        loggedErrors: [],
      });
    });

    it(`${platform}: Next file moves the focused pane forward`, function () {
      assert.deepEqual(clickMenuItem(getMenu, "menu.next_file"), {
        sent: [["shortcut", "navigate-forward"]],
        commandCalls: [],
        loggedErrors: [],
      });
    });
  }
});

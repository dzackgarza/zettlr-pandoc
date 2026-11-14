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

// Installs process-wide test doubles; it must load before the modules that read them.
import "./headless-electron-harness.cjs";
import { createShortcutConfig } from "@common/commands/command-registry";
import { strict as assert } from "assert";
import {
  BrowserWindow,
  type KeyboardEvent,
  MenuItem,
  type MenuItemConstructorOptions,
} from "electron";
import { mkdtemp, rm, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { ConfigValue } from "source/app/service-providers/config/get-config-template";
import LogProvider from "source/app/service-providers/log";
import getDarwinMenu from "source/app/service-providers/menu/menu.darwin";
import getWin32Menu from "source/app/service-providers/menu/menu.win32";
import type {
  MenuCommands,
  MenuConfig,
  MenuConfigKey,
  MenuDocuments,
  MenuLogger,
  MenuRecentDocuments,
  MenuWindows,
} from "source/app/service-providers/menu/menu-dependencies";
import { withRegisteredAccelerators } from "source/app/service-providers/menu/registered-accelerators";
import RecentDocumentsProvider from "source/app/service-providers/recent-docs";
import { bootDocumentManager } from "./documents-provider-seam";
import { sentMessagesFor } from "./headless-electron-harness.cjs";

type MenuBuilder = typeof getWin32Menu;
type Send = unknown[];

/** The keyed settings that the menu of a spec reads. */
const menuSettings: { [K in MenuConfigKey]: ConfigValue<K> } = {
  "system.zoomBehavior": "editor",
  darkMode: false,
  fileMeta: false,
  debug: false,
};

class TestMenuConfig implements MenuConfig {
  get(): {
    editor: { fontSize: number; snippetsFile: string; quickTexFile: string };
  };

  get<K extends MenuConfigKey>(key: K): ConfigValue<K>;
  get<K extends MenuConfigKey>(
    key?: K,
  ): ConfigValue<K> | { editor: { fontSize: number; snippetsFile: string; quickTexFile: string } } {
    if (key === undefined) {
      return {
        editor: {
          fontSize: 14,
          snippetsFile: "/tmp/snippets.code-snippets",
          quickTexFile: "/tmp/quicktex_dict.vim",
        },
      };
    }
    return menuSettings[key];
  }

  set<K extends "darkMode" | "fileMeta" | "editor.fontSize">(
    _key: K,
    _value: ConfigValue<K>,
  ): void {}
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
  sentToLastMainWindow: Send[];
  commandCalls: Array<[string, unknown]>;
  loggedErrors: string[];
  accelerator: string | undefined;
} {
  const commandCalls: Array<[string, unknown]> = [];
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
    run: async (command, payload) => {
      commandCalls.push([command, payload]);
      return undefined;
    },
  };
  // The focused window is a window without panes (Preferences); the main
  // window that the author used last is another window.
  const focusedWindow = new BrowserWindow();
  const lastMainWindow = new BrowserWindow();
  const windows: MenuWindows = {
    getFirstMainWindow: () => lastMainWindow,
    showAboutWindow: () => {},
    showDefaultsWindow: () => {},
    showErrorMessage: (title: string, message: string) => {
      throw new Error(`The menu item opened the error window "${title}": ${message}`);
    },
    showLogWindow: () => {},
    showPreferences: () => {},
    showTagManager: () => {},
  };
  const documents: MenuDocuments = {
    newWindow: () => {},
    openFile: async () => false,
  };

  // The menu provider gives each item the key of its registered command.
  const template = withRegisteredAccelerators(
    getMenu(
      logger,
      config,
      recentDocs,
      commands,
      windows,
      documents,
      () => false,
      () => {},
    ),
    createShortcutConfig(),
  );
  const item = findItem(template, id);
  assert.ok(item !== undefined, `the menu must expose ${id}`);
  const click = item.click;
  assert.ok(click !== undefined, `the menu item ${id} must be clickable`);

  const menuItem = new MenuItem(item);
  const event: KeyboardEvent = { triggeredByAccelerator: true };
  click(menuItem, focusedWindow, event);
  focusedWindow.close();
  lastMainWindow.close();

  return {
    sent: sentMessagesFor(focusedWindow),
    sentToLastMainWindow: sentMessagesFor(lastMainWindow),
    commandCalls,
    loggedErrors,
    accelerator: item.accelerator,
  };
}

describe("File ▸ Previous/Next file menu navigation", function () {
  const platforms: Array<[string, MenuBuilder]> = [
    ["win32/linux", getWin32Menu],
    ["darwin", getDarwinMenu],
  ];

  for (const [platform, getMenu] of platforms) {
    it(`${platform}: Previous file moves the main window that the author used last back`, function () {
      assert.deepEqual(clickMenuItem(getMenu, "menu.previous_file"), {
        sent: [],
        sentToLastMainWindow: [["shortcut", "navigate-back"]],
        commandCalls: [],
        loggedErrors: [],
        accelerator: "CmdOrCtrl+Alt+-",
      });
    });

    it(`${platform}: Next file moves the main window that the author used last forward`, function () {
      assert.deepEqual(clickMenuItem(getMenu, "menu.next_file"), {
        sent: [],
        sentToLastMainWindow: [["shortcut", "navigate-forward"]],
        commandCalls: [],
        loggedErrors: [],
        accelerator: "CmdOrCtrl+Shift+-",
      });
    });
  }
});

describe("Window ▸ Reopen Closed Tab", () => {
  const platforms: Array<[string, MenuBuilder]> = [
    ["win32/linux", getWin32Menu],
    ["darwin", getDarwinMenu],
  ];

  for (const [platform, getMenu] of platforms) {
    it(`${platform}: dispatches the reopen command from the standard accelerator`, () => {
      const result = clickMenuItem(getMenu, "menu.tab_reopen_closed");
      assert.deepEqual(result.sent, [["shortcut", "reopen-closed-tab"]]);
      assert.equal(result.accelerator, "CmdOrCtrl+Shift+T");
    });
  }
});

describe("Edit ▸ authoring source files", function () {
  const platforms: Array<[string, MenuBuilder]> = [
    ["win32/linux", getWin32Menu],
    ["darwin", getDarwinMenu],
  ];

  for (const [platform, getMenu] of platforms) {
    it(`${platform}: Edit snippets opens the configured snippets file`, function () {
      const result = clickMenuItem(getMenu, "menu.edit_snippets");
      assert.deepEqual(result.sent, [["shortcut", "edit-snippets"]]);
      assert.deepEqual(result.commandCalls, []);
    });

    it(`${platform}: Edit QuickTeX definitions opens the configured Vimscript`, function () {
      const result = clickMenuItem(getMenu, "menu.edit_quicktex");
      assert.deepEqual(result.sent, [["shortcut", "edit-quicktex"]]);
      assert.deepEqual(result.commandCalls, []);
    });
  }
});

describe("File ▸ Recent files", function () {
  let workspace = "";

  beforeEach(async function () {
    workspace = await mkdtemp(path.join(tmpdir(), "zettlr-menu-recent-"));
  });

  afterEach(async function () {
    await rm(workspace, { recursive: true, force: true });
  });

  it("win32/linux: a recent file that another program removed gives one error window that names it", async function () {
    const gone = path.join(workspace, "orbits.md");
    await writeFile(gone, "# Orbits\n");
    // The real list and the real document manager: the author opened the
    // file once, and the menu was built while the file was on disk.
    const recentDocs = new RecentDocumentsProvider(new LogProvider(), {
      get: () => ({ ui: { recentFilesLimit: 10 } }),
    });
    recentDocs.add(gone);
    const documents = await bootDocumentManager([workspace]);
    const shown: Array<{ title: string; message: string }> = [];
    const windows: MenuWindows = {
      getFirstMainWindow: () => undefined,
      showAboutWindow: () => {},
      showDefaultsWindow: () => {},
      showLogWindow: () => {},
      showPreferences: () => {},
      showTagManager: () => {},
      showErrorMessage: (title: string, message: string) => {
        shown.push({ title, message });
      },
    };
    const template = getWin32Menu(
      { error: () => {} },
      new TestMenuConfig(),
      recentDocs,
      { run: async () => undefined },
      windows,
      documents,
      () => false,
      () => {},
    );
    const item = findItem(template, `menu.recent_docs.${gone}`);
    assert.ok(item?.click !== undefined, "the menu lists the recent file");

    // Another program removes the file; the menu still lists it.
    await unlink(gone);
    const focusedWindow = new BrowserWindow();
    item.click(new MenuItem(item), focusedWindow, { triggeredByAccelerator: false });
    focusedWindow.close();
    const deadline = Date.now() + 5_000;
    while (shown.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(shown.length, 1, "one refused open opens one error window");
    assert.ok(shown[0].message.includes(gone), `the message names ${gone}: ${shown[0].message}`);
    await documents.shutdown();
  });
});

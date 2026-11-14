/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Menu constructor for macOS
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file exposes a getMenu function returning the macOS application menu.
 *
 * END HEADER
 */

import { editMenuItems } from "@common/commands/editing-menu-items";
import { trans } from "@common/i18n-main";
import { sendIPCMessage } from "@common/util/broadcast-ipc-message";
import { DocumentType } from "@dts/common/documents";
import { app, BrowserWindow, dialog, type MenuItemConstructorOptions, shell } from "electron";
import path from "path";
import { openPath } from "source/app/util/open-path";
import { zoomIn, zoomOut } from "./font-zoom";
import type {
  MenuCommands,
  MenuConfig,
  MenuDocuments,
  MenuLogger,
  MenuRecentDocuments,
  MenuWindows,
} from "./menu-dependencies";
import {
  authoringSourceItems,
  commandLauncherItem,
  desktopFileItems,
  fileLauncherItem,
  formatMenu,
  ignoreRulesItem,
  insertMenu,
  sendShortcut,
  statisticsItem,
} from "./menu-editing";
import openPandocQuickHelp from "./open-pandoc-quick-help";

export default function getMenu(
  logger: MenuLogger,
  config: MenuConfig,
  _recentDocs: MenuRecentDocuments,
  commands: MenuCommands,
  windows: MenuWindows,
  documents: MenuDocuments,
  _getCheckboxState: (id: string, init: boolean) => boolean,
  _setCheckboxState: (id: string, val: boolean) => void,
): MenuItemConstructorOptions[] {
  const useGuiZoom = config.get("system.zoomBehavior") === "gui";
  // A menu action that is no command shows its failure itself, once. The
  // dispatcher shows the failure of a command (`commands.run`).
  const showFailure =
    (title: string) =>
    (failure: Error): void => {
      logger.error(failure.message, failure);
      windows.showErrorMessage(title, failure.message);
    };

  const updateMenuItem: MenuItemConstructorOptions = {
    id: "menu.update",
    label: trans("Check for updates"),
    click: function (_menuitem, _focusedWindow) {
      // Immediately open the window instead of first checking
      commands.run("open-update-window", undefined).catch((e: Error) => logger.error(e.message, e));
    },
  };

  const edit = editMenuItems(trans);
  const menu: MenuItemConstructorOptions[] = [
    // APP MENU
    {
      id: "app-menu",
      label: "Zettlr",
      submenu: [
        {
          id: "macos-about",
          label: trans("About Zettlr"),
          role: "about",
        },
        {
          id: "menu.preferences",
          label: trans("Preferences…"),
          click: function (_menuitem, _focusedWindow) {
            windows.showPreferences();
          },
        },
        {
          id: "menu.assets_manager",
          label: trans("Assets Manager"),
          click: function (_menuitem, _focusedWindow) {
            windows.showDefaultsWindow();
          },
        },
        {
          id: "menu.tags",
          label: trans("Tags Manager"),
          click: function (_menuitem, _focusedWindow) {
            windows.showTagManager();
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.services",
          label: trans("Services"),
          role: "services",
          submenu: [],
        },
        {
          type: "separator",
        },
        {
          id: "menu.hide",
          label: trans("Hide"),
          role: "hide",
        },
        {
          id: "menu.hide_others",
          label: trans("Hide others"),
          role: "hideOthers",
        },
        {
          id: "menu.unhide",
          label: trans("Show"),
          role: "unhide",
        },
        {
          type: "separator",
        },
        {
          id: "menu-quit",
          label: trans("Quit"),
          role: "quit",
        },
      ],
    },
    // FILE MENU
    {
      id: "file-menu",
      label: trans("File"),
      submenu: [
        {
          label: trans("New file…"),
          submenu: [
            {
              id: "menu.new_file",
              label: "Markdown",
              click: function (_menuitem, _focusedWindow) {
                commands
                  .run("file-new", { type: DocumentType.Markdown })
                  .catch((e: Error) => logger.error(e.message, e));
              },
            },
            {
              id: "menu.new_tex_file",
              label: "TeX",
              click: function (_menuitem, _focusedWindow) {
                commands
                  .run("file-new", { type: DocumentType.LaTeX })
                  .catch((e: Error) => logger.error(e.message, e));
              },
            },
            {
              id: "menu.new_yaml_file",
              label: "YAML",
              click: function (_menuitem, _focusedWindow) {
                commands
                  .run("file-new", { type: DocumentType.YAML })
                  .catch((e: Error) => logger.error(e.message, e));
              },
            },
            {
              id: "menu.new_json_file",
              label: "JSON",
              click: function (_menuitem, _focusedWindow) {
                commands
                  .run("file-new", { type: DocumentType.JSON })
                  .catch((e: Error) => logger.error(e.message, e));
              },
            },
          ],
        },
        {
          id: "menu.new_dir",
          label: trans("New directory…"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "new-dir");
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.open",
          label: trans("Open file…"),
          click: function (_menuitem, _focusedWindow) {
            commands
              .run("root-open-files", undefined)
              .catch((e: Error) => logger.error(e.message, e));
          },
        },
        {
          id: "menu.open_workspace",
          label: trans("Open workspace…"),
          click: function (_menuitem, _focusedWindow) {
            commands
              .run("root-open-workspaces", undefined)
              .catch((e: Error) => logger.error(e.message, e));
          },
        },
        {
          id: "menu.recent_docs",
          label: trans("Recent files"),
          role: "recentDocuments",
          submenu: [
            {
              id: "menu.clear_recent_docs",
              label: trans("Clear"),
              role: "clearRecentDocuments",
            },
          ],
        },
        {
          type: "separator",
        },
        ...desktopFileItems(),
        {
          type: "separator",
        },
        {
          id: "menu.save",
          label: trans("Save"),
          click: function (_menuItem, focusedWindow) {
            sendShortcut(focusedWindow, "save-file");
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.previous_file",
          label: trans("Previous file"),
          click: function () {
            // Session history is per-pane, and the renderer owns which pane is
            // focused, so the navigation request goes out on the same
            // 'shortcut' channel the swipe and browser back/forward gestures
            // use (create-main-window.ts). It goes to the main window that the
            // author used last: with the focus in Preferences or another
            // window without panes, that main window goes back (#57).
            const mainWindow = windows.getFirstMainWindow();
            if (mainWindow !== undefined) {
              sendIPCMessage(mainWindow.webContents, "shortcut", "navigate-back");
            }
          },
        },
        {
          id: "menu.next_file",
          label: trans("Next file"),
          click: function () {
            const mainWindow = windows.getFirstMainWindow();
            if (mainWindow !== undefined) {
              sendIPCMessage(mainWindow.webContents, "shortcut", "navigate-forward");
            }
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.import_files",
          label: trans("Import files…"),
          click: function (_menuItem, _focusedWindow) {
            commands
              .run("import-files", undefined)
              .catch((e: Error) => logger.error("[Menu Provider] Cannot import files", e));
          },
        },
        {
          id: "menu.export",
          label: trans("Export…"),
          click: function (_menuItem, focusedWindow) {
            sendShortcut(focusedWindow, "export");
          },
        },
        {
          id: "menu.print",
          label: trans("Print…"),
          click: function (_menuItem, focusedWindow) {
            sendShortcut(focusedWindow, "print");
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.import_lang_file",
          label: trans("Import translation…"),
          click: function (_menuItem, _focusedWindow) {
            commands
              .run("import-lang-file", undefined)
              .catch((e: Error) => logger.error("[Menu Provider] Cannot import translation", e));
          },
        },
        {
          id: "menu.import_dict_file",
          label: trans("Import dictionary…"),
          click: function (_menuitem, _focusedWindow) {
            openPath(path.join(app.getPath("userData"), "/dict")).catch(
              showFailure(trans("Could not open the dictionary folder")),
            );
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.rename_file",
          label: trans("Rename file"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "rename-file");
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.delete_file",
          label: trans("Delete file"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "delete-file");
          },
        },
      ],
    },
    // EDIT MENU
    {
      id: "edit-menu",
      label: trans("Edit"),
      submenu: [
        {
          id: "menu.undo",
          label: trans("Undo"),
          role: "undo",
        },
        {
          id: "menu.redo",
          label: trans("Redo"),
          role: "redo",
        },
        {
          type: "separator",
        },
        {
          ...edit.cut,
          role: "cut",
        },
        {
          ...edit.copy,
          role: "copy",
        },
        {
          ...edit.copyAsHtml,
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "copy-as-html");
          },
        },
        {
          ...edit.paste,
          role: "paste",
        },
        {
          ...edit.pasteAsPlain,
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "paste-as-plain");
          },
        },
        {
          ...edit.selectAll,
          role: "selectAll",
        },
        {
          type: "separator",
        },
        {
          id: "menu.find_file",
          label: trans("Find in current file"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "search");
          },
        },
        {
          id: "menu.find_dir",
          label: trans("Search all files"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "global-search");
          },
        },
        {
          id: "menu.filter_files",
          label: trans("Search files"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "filter-files");
          },
        },
        ignoreRulesItem(),
        {
          type: "separator",
        },
        ...authoringSourceItems(config),
        {
          type: "separator",
        },
        {
          id: "menu.generate_id",
          label: trans("Generate new ID"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "insert-id");
          },
        },
        {
          id: "menu.copy_id",
          label: trans("Copy ID"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "copy-current-id");
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.speech",
          label: trans("Speech"),
          submenu: [
            {
              id: "menu.start_speaking",
              label: trans("Start speaking"),
              role: "startSpeaking",
            },
            {
              id: "menu.stop_speaking",
              label: trans("Stop speaking"),
              role: "stopSpeaking",
            },
          ],
        },
      ],
    },
    // INSERT AND FORMAT MENUS (shared with Windows and Linux)
    insertMenu(),
    formatMenu(),
    // VIEW MENU
    {
      id: "view-menu",
      label: trans("View"),
      submenu: [
        commandLauncherItem(),
        fileLauncherItem(),
        statisticsItem(commands),
        {
          type: "separator",
        },
        {
          id: "menu.toggle_theme",
          label: trans("Dark mode"),
          type: "checkbox",
          checked: config.get("darkMode"),
          click: function (_menuitem, _focusedWindow) {
            config.set("darkMode", !config.get("darkMode"));
          },
        },
        {
          id: "menu.toggle_file_meta",
          label: trans("Additional information"),
          type: "checkbox",
          checked: config.get("fileMeta"),
          click: function (_menuitem, _focusedWindow) {
            config.set("fileMeta", !config.get("fileMeta"));
          },
        },
        {
          id: "menu.toggle_distraction_free",
          label: trans("Distraction-free mode"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "toggle-distraction-free");
          },
        },
        {
          id: "menu.toggle_typewriter_mode",
          label: trans("Typewriter mode"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "toggle-typewriter-mode");
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.toggle_navigation_sidebar",
          label: trans("Toggle Sidebar"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "toggle-navigation-sidebar");
          },
        },
        {
          id: "menu.problems_reveal",
          label: trans("Problems: Reveal"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "problems-reveal");
          },
        },
        {
          id: "menu.toggle_annotation_panel",
          label: trans("Toggle Annotation Panel"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "toggle-annotation-panel");
          },
        },
        {
          type: "separator",
        },
        // The Zoom menu items can be changed in function between GUI zooming
        // (using the zoom roles) and editor font size zooming (using a custom
        // callback)
        {
          id: "menu.reset_zoom",
          label: trans("Reset zoom"),
          // NOTE: Since the base font-size can change, resetting the editor
          // font size zoom level is not semantically meaningful
          enabled: useGuiZoom,
          role: useGuiZoom ? "resetZoom" : undefined,
        },
        {
          id: "menu.zoom_in",
          label: trans("Zoom in"),
          role: useGuiZoom ? "zoomIn" : undefined,
          click: useGuiZoom ? undefined : zoomIn(config),
        },
        {
          id: "menu.zoom_out",
          label: trans("Zoom out"),
          role: useGuiZoom ? "zoomOut" : undefined,
          click: useGuiZoom ? undefined : zoomOut(config),
        },
        {
          type: "separator",
        },
        {
          id: "menu.toggle_fullscreen",
          label: trans("Toggle fullscreen"),
          role: "togglefullscreen",
        },
      ],
    },
    // DEVELOP MENU
    {
      id: "debug-menu",
      label: trans("Develop"),
      submenu: [
        {
          id: "menu.reload",
          label: trans("Reload"),
          click: function (_menuitem, focusedWindow) {
            (focusedWindow as BrowserWindow | undefined)?.reload();
          },
        },
        {
          id: "menu.toggle_devtools",
          label: trans("Toggle developer tools"),
          click: function (_menuitem, focusedWindow) {
            (focusedWindow as BrowserWindow | undefined)?.webContents.toggleDevTools();
          },
        },
        {
          id: "menu.open_logs",
          label: trans("View logs"),
          click: function (_menuitem, _focusedWindow) {
            windows.showLogWindow();
          },
        },
      ],
    },
    // WINDOW MENU
    {
      id: "window-menu",
      label: trans("Window"),
      role: "window",
      submenu: [
        {
          id: "menu.win_minimize",
          label: trans("Minimize"),
          click: function (_menuitem, focusedWindow) {
            (focusedWindow as BrowserWindow | undefined)?.minimize();
          },
        },
        {
          id: "menu.win_close",
          label: trans("Close"),
          role: "close",
        },
        {
          id: "menu.all_front",
          label: trans("Bring All to Front"),
          role: "front",
        },
        {
          type: "separator",
        },
        {
          id: "menu.tab_close",
          label: trans("Close Tab"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "close-window");
          },
        },
        {
          id: "menu.tab_reopen_closed",
          label: trans("Reopen Closed Tab"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "reopen-closed-tab");
          },
        },
        {
          id: "menu.tabs_close_all",
          label: trans("Close All Tabs"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "close-all-tabs");
          },
        },
        {
          id: "menu.tabs_save_all",
          label: trans("Save All"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "save-all");
          },
        },
        {
          id: "menu.tabs_save_all_close",
          label: trans("Save All and Close"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "save-all-and-close");
          },
        },
        {
          id: "menu.tab_previous",
          label: trans("Previous Tab"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "previous-tab");
          },
        },
        {
          id: "menu.tab_next",
          label: trans("Next Tab"),
          click: function (_menuitem, focusedWindow) {
            sendShortcut(focusedWindow, "next-tab");
          },
        },
        {
          id: "menu.new_window",
          label: trans("New window"),
          click: function (_menuItem, _focusedWindow) {
            documents.newWindow();
          },
        },
      ],
    },
    // HELP MENU
    {
      id: "help-menu",
      label: trans("Help"),
      role: "help",
      submenu: [
        {
          id: "menu.about",
          label: trans("About Zettlr"),
          click: function (_menuitem, _focusedWindow) {
            windows.showAboutWindow();
          },
        },
        ...(__UPDATES_DISABLED__ === "0" ? [updateMenuItem] : []),
        {
          type: "separator",
        },
        {
          id: "menu.donate",
          label: trans("Support Zettlr ↗︎"),
          click: function (_menuitem, _focusedWindow) {
            const target = "https://patreon.com/zettlr";
            shell.openExternal(target).catch(showFailure(trans("Could not open %s", target)));
          },
        },
        {
          id: "menu.learn_more",
          label: trans("Visit website ↗︎"),
          click: function (_menuitem, _focusedWindow) {
            const target = "https://www.zettlr.com/";
            shell.openExternal(target).catch(showFailure(trans("Could not open %s", target)));
          },
        },
        {
          id: "menu.docs",
          label: trans("Open user manual ↗︎"),
          click: function (_menuitem, _focusedWindow) {
            const target = "https://docs.zettlr.com/";
            shell.openExternal(target).catch(showFailure(trans("Could not open %s", target)));
          },
        },
        {
          id: "menu.pandoc_quick_reference",
          label: trans("Pandoc quick reference…"),
          click: function (_menuitem, focusedWindow) {
            openPandocQuickHelp(focusedWindow as BrowserWindow | undefined);
          },
        },
        {
          type: "separator",
        },
        {
          id: "menu.open_tutorial",
          label: trans("Open tutorial"),
          click: function (_menuitem, _focusedWindow) {
            commands
              .run("tutorial-open", undefined)
              .catch((e: Error) => logger.error(e.message, e));
          },
        },
        {
          id: "menu.clear_fsal_cache",
          label: trans("Clear FSAL cache…"),
          click: function (_menuitem, _focusedWindow) {
            // Clearing the FSAL cache requires a restart -> prompt the user
            dialog
              .showMessageBox({
                title: trans("Clear FSAL Cache"),
                message: trans("Clearing the FSAL cache requires a restart."),
                detail: trans(
                  "After the restart, Zettlr will recreate the entire cache, which may take a few moments, depending on the amount of files you have loaded and the speed of your disk. The window(s) will show afterward.",
                ),
                type: "question",
                buttons: [trans("Restart now"), trans("Cancel")],
                defaultId: 0,
                cancelId: 1,
              })
              .then((result) => {
                if (result.response === 1) {
                  return;
                }

                app.relaunch({ args: process.argv.slice(1).concat(["--clear-cache"]) });
                app.quit();
              })
              .catch((err: Error) => logger.error(err.message, err));
          },
        },
      ],
    },
  ];

  // Finally, before returning, make sure to remove the debug menu if applicable
  if (!config.get("debug")) {
    const debugMenuIndex = menu.findIndex((item) => item.id === "debug-menu");
    if (debugMenuIndex >= 0) {
      menu.splice(debugMenuIndex, 1);
    }
  }

  return menu;
}

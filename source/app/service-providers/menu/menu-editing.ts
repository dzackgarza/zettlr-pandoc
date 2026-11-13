/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editing menus
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The application-menu items both platform templates share
 *                  for editing: the command launcher, the writing statistics,
 *                  desktop file actions, and the Insert and Format menus. Each item is the one
 *                  definition of its command: the launcher's rows, labels,
 *                  shortcut chips and enablement come from these items over
 *                  the menu-provider IPC, and each click sends the window
 *                  the typed shortcut name that runs it.
 *
 * END HEADER
 */

import {
  type EditorCommandMenuItem,
  editorCommandMenuItems,
  tableMenu,
} from "@common/commands/editing-menu-items";
import { trans } from "@common/i18n-main";
import type { InsertTablePayload, ShortcutName } from "@dts/common/shortcut-names";
import type { BaseWindow, BrowserWindow, MenuItemConstructorOptions } from "electron";
import type { MenuCommands, MenuConfig } from "./menu-dependencies";

/** Electron types the focused window as possibly undefined; at runtime the provider also passes null. */
type FocusedWindow = BrowserWindow | BaseWindow | undefined | null;

/**
 * Sends a window the typed shortcut name (and, for a table, its size).
 *
 * The window comes from the item's click, where Electron passes the window
 * that held the focus. The item was picked, so one has to receive it.
 */
export function sendShortcut(
  window: FocusedWindow,
  name: ShortcutName,
  payload?: InsertTablePayload,
): void {
  if (window === undefined || window === null || !("webContents" in window)) {
    throw new Error(
      `The menu item for the ${name} shortcut has no window to send it to: Electron passed ${String(window)}. ` +
        "A menu item acts on the focused window, and the menu provider resolves the sender of click-menu-item " +
        "when the OS reports no focused window (source/app/service-providers/menu/index.ts). " +
        "Fix that resolution; the item cannot be carried out with no window.",
    );
  }
  if (payload === undefined) {
    window.webContents.send("shortcut", name);
  } else {
    window.webContents.send("shortcut", name, payload);
  }
}

/**
 * One Insert or Format item: its click sends the editor command it names. Its
 * key is the key of the registered command of the item (`menuItems`).
 */
function editorCommandItem({
  id,
  label,
  command,
}: EditorCommandMenuItem): MenuItemConstructorOptions {
  return {
    id,
    label,
    click: (_item, focusedWindow) => {
      sendShortcut(focusedWindow, command);
    },
  };
}

/** The "Command launcher…" item of the View menu. */
export function commandLauncherItem(): MenuItemConstructorOptions {
  return {
    id: "menu.command_launcher",
    label: trans("Command launcher…"),
    click: (_item, focusedWindow) => {
      sendShortcut(focusedWindow, "open-command-launcher");
    },
  };
}

/** The "Go to file…" item of the View menu: opens the launcher's workspace-file view. */
export function fileLauncherItem(): MenuItemConstructorOptions {
  return {
    id: "menu.file_launcher",
    label: trans("Go to file…"),
    click: (_item, focusedWindow) => {
      sendShortcut(focusedWindow, "open-file-launcher");
    },
  };
}

/** The "Writing statistics…" item of the View menu: the statistics window. */
export function statisticsItem(commands: MenuCommands): MenuItemConstructorOptions {
  return {
    id: "menu.statistics",
    label: trans("Writing statistics…"),
    click: () => {
      commands.run("open-stats-window", undefined);
    },
  };
}

/** Edit file filters…: the dialog that edits the ignore rules. */
export function ignoreRulesItem(): MenuItemConstructorOptions {
  return {
    id: "menu.edit_ignore_rules",
    label: trans("Edit file filters…"),
    click: (_item, focusedWindow) => {
      sendShortcut(focusedWindow, "edit-ignore-rules");
    },
  };
}

/** File-menu desktop actions. Their target is resolved by the focused renderer. */
export function desktopFileItems(): MenuItemConstructorOptions[] {
  return [
    {
      id: "menu.open_terminal_here",
      label: trans("Open terminal here"),
      click: (_item, focusedWindow) => {
        sendShortcut(focusedWindow, "open-terminal-here");
      },
    },
    {
      id: "menu.open_file_externally",
      label: trans("Open file in external editor"),
      click: (_item, focusedWindow) => {
        sendShortcut(focusedWindow, "open-file-externally");
      },
    },
    {
      id: "menu.open_file_browser_here",
      label: trans("Open file browser here"),
      click: (_item, focusedWindow) => {
        sendShortcut(focusedWindow, "open-file-browser-here");
      },
    },
  ];
}

/** Edit-menu leaves for the two user-owned authoring source files. */
export function authoringSourceItems(config: MenuConfig): MenuItemConstructorOptions[] {
  const sources = [
    {
      id: "menu.edit_snippets",
      label: trans("Edit snippets"),
      filePath: config.get().editor.snippetsFile,
      shortcut: "edit-snippets" as const,
    },
    {
      id: "menu.edit_quicktex",
      label: trans("Edit QuickTeX definitions"),
      filePath: config.get().editor.quickTexFile,
      shortcut: "edit-quicktex" as const,
    },
  ] as const;

  return sources.map(({ id, label, filePath, shortcut }) => ({
    id,
    label,
    enabled: filePath.trim() !== "",
    click: (_item, focusedWindow) => {
      sendShortcut(focusedWindow, shortcut);
    },
  }));
}

/** The Insert menu: links, images, tables, footnotes, comments, Pandoc blocks, task lists. */
export function insertMenu(): MenuItemConstructorOptions {
  const items = editorCommandMenuItems(trans);
  const table = tableMenu(trans);

  return {
    id: "insert-menu",
    label: trans("Insert"),
    submenu: [
      editorCommandItem(items.link),
      editorCommandItem(items.image),
      {
        id: table.id,
        label: table.label,
        submenu: table.sizes.map(({ id, label, rows, cols }) => ({
          id,
          label,
          click: (_item, focusedWindow) => {
            sendShortcut(focusedWindow, "insert-table", { rows, cols });
          },
        })),
      },
      editorCommandItem(items.footnote),
      editorCommandItem(items.comment),
      { type: "separator" },
      {
        id: "menu.insert_pandoc_div",
        label: trans("Pandoc div"),
        click: (_item, focusedWindow) => {
          sendShortcut(focusedWindow, "insert-pandoc-div");
        },
      },
      {
        id: "menu.insert_pandoc_span",
        label: trans("Pandoc span"),
        click: (_item, focusedWindow) => {
          sendShortcut(focusedWindow, "insert-pandoc-span");
        },
      },
      { type: "separator" },
      editorCommandItem(items.taskList),
    ],
  };
}

/** The Format menu: headings, inline marks, lists and block quotes. */
export function formatMenu(): MenuItemConstructorOptions {
  const items = editorCommandMenuItems(trans);
  const headings: MenuItemConstructorOptions[] = ([1, 2, 3, 4, 5, 6] as const).map((level) =>
    editorCommandItem({
      id: `menu.format_heading_${level}`,
      label: trans("Heading %s", level),
      command: `markdownHeading${level}`,
    }),
  );

  return {
    id: "format-menu",
    label: trans("Format"),
    submenu: [
      ...headings,
      { type: "separator" },
      editorCommandItem(items.bold),
      editorCommandItem(items.italic),
      editorCommandItem(items.code),
      editorCommandItem(items.strikethrough),
      { type: "separator" },
      editorCommandItem(items.bulletList),
      editorCommandItem(items.orderedList),
      editorCommandItem(items.blockquote),
      { type: "separator" },
      {
        id: "menu.fix_all_document",
        label: trans("Fix all auto-fixable issues in the document"),
        click: (_item, focusedWindow) => {
          sendShortcut(focusedWindow, "fix-all-document");
        },
      },
      {
        id: "menu.fix_all_open",
        label: trans("Fix all auto-fixable issues in open documents"),
        click: (_item, focusedWindow) => {
          sendShortcut(focusedWindow, "fix-all-open");
        },
      },
      {
        id: "menu.fix_all_workspace",
        label: trans("Fix all auto-fixable issues in the workspace"),
        click: (_item, focusedWindow) => {
          sendShortcut(focusedWindow, "fix-all-workspace");
        },
      },
    ],
  };
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The items and keys of the editor context menus
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An item of a context menu of the editor that the
 *                  application menu has too is that item (#202): it has the
 *                  id and the label of the application-menu item and the key
 *                  that the command registry gives its command (the key that
 *                  the author configured, or the key of the platform). An
 *                  Insert or Format item runs its editor command on the view
 *                  of the menu. Cut, Copy, Paste and Select all give that
 *                  view the focus and click the application-menu item, so a
 *                  copy in a review goes through the copy handler of the
 *                  review. Copy as HTML and Paste without style run on the
 *                  view of the menu.
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import { commandAccelerator, commandForMenuItem } from "@common/commands/command-registry";
import {
  type EditMenuItem,
  type EditorCommandMenuItem,
  emptyPipeTable,
  tableMenu,
} from "@common/commands/editing-menu-items";
import { trans } from "@common/i18n-renderer";
import { type AnyMenuItem } from "@common/modules/window-register/application-menu-helper";
import { cmShortcutToElectron } from "source/common/util/shortcuts";
import { runEditorCommand } from "../commands/editor-commands";
import { type EditorShortcutName, getCustomShortcut } from "../keymaps/shortcuts";
import { configField } from "../util/configuration";

/** The accelerator of an editor command, as the author configured it. */
export function editorMenuAccelerator(
  view: EditorView,
  name: EditorShortcutName,
): string | undefined {
  return cmShortcutToElectron(getCustomShortcut(name, view.state.field(configField).shortcuts));
}

/** The accelerator of the command of an application-menu item. */
function menuItemAccelerator(view: EditorView, menuItemId: string): string | undefined {
  const command = commandForMenuItem(menuItemId);
  if (command === undefined) {
    return undefined;
  }
  const editor: Record<string, string> = {};
  for (const { name, shortcut } of view.state.field(configField).shortcuts) {
    editor[name] = shortcut;
  }
  return commandAccelerator(command, { editor, ui: {} });
}

/** An Insert or Format item that runs its editor command on `view`. */
export function editorCommandItem(view: EditorView, item: EditorCommandMenuItem): AnyMenuItem {
  return {
    id: item.id,
    label: item.label,
    accelerator: menuItemAccelerator(view, item.id),
    type: "normal",
    action() {
      runEditorCommand(view, item.command);
    },
  };
}

/** Insert → Table: each size replaces the selection of `view` with a new table. */
export function tableSubmenu(view: EditorView): AnyMenuItem {
  const table = tableMenu(trans);
  return {
    id: table.id,
    label: table.label,
    type: "submenu",
    submenu: table.sizes.map(
      ({ id, label, rows, cols }): AnyMenuItem => ({
        id,
        label,
        type: "normal",
        action() {
          view.dispatch(view.state.replaceSelection(emptyPipeTable(rows, cols)));
          view.focus();
        },
      }),
    ),
  };
}

/**
 * Cut, Copy, Paste and Select all: `view` gets the focus, and the
 * application-menu item runs on the focused element.
 */
export function roleItem(view: EditorView, item: EditMenuItem): AnyMenuItem {
  return {
    id: item.id,
    label: item.label,
    accelerator: menuItemAccelerator(view, item.id),
    type: "normal",
    action() {
      view.focus();
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: item.id });
    },
  };
}

/** An Edit item that runs `run` on `view`, as its key does in that view. */
export function viewItem(
  view: EditorView,
  item: EditMenuItem,
  run: (view: EditorView) => unknown,
): AnyMenuItem {
  return {
    id: item.id,
    label: item.label,
    accelerator: menuItemAccelerator(view, item.id),
    type: "normal",
    action() {
      run(view);
    },
  };
}

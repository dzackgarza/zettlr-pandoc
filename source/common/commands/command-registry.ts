/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Application command registry
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single declaration surface for commands that users
 *                  can bind. A registration owns its identity, label,
 *                  scope, context, default keybinding, Preferences group,
 *                  palette visibility, and optional editor handler.
 *
 * END HEADER
 */

import type { EditorView, KeyBinding } from "@codemirror/view";
import {
  cmShortcutToElectron,
  type DefaultShortcut,
  getDefaultKeybinding,
  normalizeShortcut,
} from "@common/util/shortcuts";

export const ANNOTATE_SELECTION_EVENT = "zettlr-annotate-selection";

export type CommandScope = "editor" | "window";
export type CommandWhen = "editorFocus" | "editorHasSelection" | "window";
export type CommandGroup =
  | "Autocomplete"
  | "Debug"
  | "Editing"
  | "File"
  | "Folding"
  | "Help"
  | "Navigation"
  | "Search"
  | "Selection"
  | "Tables"
  | "Transformations"
  | "User Interface"
  | "View"
  | "Window";

export interface CommandRegistration<Id extends string = string> {
  id: Id;
  label: string;
  group: CommandGroup;
  scope: CommandScope;
  when: CommandWhen;
  defaultKeybinding: DefaultShortcut;
  palette: boolean;
  run?: (view: EditorView) => boolean;
  /**
   * The ids of the menu and context-menu items that run this command. Each
   * such item shows the key of the command (`commandAccelerator`).
   */
  menuItems?: readonly string[];
  /**
   * The key is the key of the platform (copy, paste, undo): the author
   * cannot bind it, and the Preferences do not list it. A conflict with it
   * is a conflict all the same.
   */
  fixed?: true;
}

/** Keeps every registration literal so its id remains a useful union type. */
export function registerCommand<const Registration extends CommandRegistration>(
  registration: Registration,
): Registration & CommandRegistration<Registration["id"]> {
  return registration;
}

const registrations = [
  registerCommand({
    id: "autocomplete-invoke",
    label: "Show autocomplete",
    group: "Autocomplete",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-Space" },
    palette: false,
  }),
  registerCommand({
    id: "autocomplete-accept",
    label: "Accept autocomplete suggestion",
    group: "Autocomplete",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Enter" },
    palette: false,
  }),
  registerCommand({
    id: "md-insert-link",
    label: "Insert link",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-k" },
    palette: false,
    menuItems: ["menu.insert_link"],
  }),
  registerCommand({
    id: "md-insert-image",
    label: "Insert image",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-i", mac: "Mod-Shift-i" },
    palette: false,
    menuItems: ["menu.insert_image"],
  }),
  registerCommand({
    id: "md-insert-footnote",
    label: "Insert footnote",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-f", mac: "Mod-Alt-r" },
    palette: false,
    menuItems: ["menu.insert_footnote"],
  }),
  registerCommand({
    id: "md-highlight",
    label: "Highlight selection",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-Shift-h" },
    palette: false,
  }),
  registerCommand({
    id: "md-format-document",
    label: "Format document",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-l" },
    palette: false,
  }),
  registerCommand({
    id: "md-bold",
    label: "Bold",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-b" },
    palette: false,
    menuItems: ["menu.format_bold"],
  }),
  registerCommand({
    id: "md-italic",
    label: "Italic",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-i" },
    palette: false,
    menuItems: ["menu.format_italic"],
  }),
  registerCommand({
    id: "md-task-list",
    label: "Toggle task list",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-t" },
    palette: false,
    menuItems: ["menu.insert_task_list"],
  }),
  registerCommand({
    id: "md-comment",
    label: "Insert comment",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift-c" },
    palette: false,
    menuItems: ["menu.insert_comment"],
  }),
  registerCommand({
    id: "annotate-selection",
    label: "Annotate for AI…",
    group: "Editing",
    scope: "editor",
    when: "editorHasSelection",
    defaultKeybinding: {},
    palette: true,
    run(view: EditorView): boolean {
      const selection = view.state.selection.main;
      if (selection.empty) {
        return false;
      }
      const ownerWindow = view.dom.ownerDocument.defaultView ?? window;
      view.dom.dispatchEvent(
        new ownerWindow.CustomEvent(ANNOTATE_SELECTION_EVENT, {
          bubbles: true,
          detail: { from: selection.from, to: selection.to },
        }),
      );
      return true;
    },
  }),
  registerCommand({
    id: "search-find-next",
    label: "Find next",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-g" },
    palette: false,
  }),
  registerCommand({
    id: "search-find-previous",
    label: "Find previous",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift-g" },
    palette: false,
  }),
  registerCommand({
    id: "search-select-matches",
    label: "Select all matches",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    // Mod-Shift-l is Copy ID of the window. Alt-Enter selects all matches
    // in the search field of CodeMirror and of VS Code.
    defaultKeybinding: { key: "Alt-Enter" },
    palette: false,
  }),
  registerCommand({
    id: "search-go-to-line",
    label: "Go to line",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-g" },
    palette: false,
  }),
  registerCommand({
    id: "search-select-next",
    label: "Select next occurrence",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-d" },
    palette: false,
  }),
  registerCommand({
    id: "search-find",
    label: "Find in file",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-f" },
    palette: false,
    menuItems: ["menu.find_file"],
  }),
  // The keys of VS Code's Go Back and Go Forward. Alt-Arrow moves a table
  // row or column.
  registerCommand({
    id: "nav-history-back",
    label: "Go back in this pane's history",
    group: "Navigation",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt--", mac: "Ctrl--" },
    palette: false,
    menuItems: ["menu.previous_file"],
  }),
  registerCommand({
    id: "nav-history-forward",
    label: "Go forward in this pane's history",
    group: "Navigation",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift--", mac: "Ctrl-Shift--" },
    palette: false,
    menuItems: ["menu.next_file"],
  }),
  registerCommand({
    id: "folding-fold-at-cursor",
    label: "Fold at cursor",
    group: "Folding",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[" },
    palette: false,
  }),
  registerCommand({
    id: "folding-unfold-at-cursor",
    label: "Unfold at cursor",
    group: "Folding",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]" },
    palette: false,
  }),
  registerCommand({
    id: "folding-fold-all",
    label: "Fold all",
    group: "Folding",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-Alt-[" },
    palette: false,
  }),
  registerCommand({
    id: "folding-unfold-all",
    label: "Unfold all",
    group: "Folding",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-Alt-]" },
    palette: false,
  }),
  registerCommand({
    id: "table-align",
    label: "Align Markdown table under cursor",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift-a" },
    palette: false,
  }),
  registerCommand({
    id: "table-align-col-left",
    label: "Align table column left",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "table-align-col-center",
    label: "Align table column center",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "table-align-col-right",
    label: "Align table column right",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "table-swap-prev-row",
    label: "Move row up",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-ArrowUp" },
    palette: false,
  }),
  registerCommand({
    id: "table-swap-next-row",
    label: "Move row down",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-ArrowDown" },
    palette: false,
  }),
  registerCommand({
    id: "table-swap-prev-col",
    label: "Move column left",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-ArrowLeft" },
    palette: false,
  }),
  registerCommand({
    id: "table-swap-next-col",
    label: "Move column right",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-ArrowRight" },
    palette: false,
  }),
  registerCommand({
    id: "table-add-row-before",
    label: "Insert new row above",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-Shift-ArrowUp" },
    palette: false,
  }),
  registerCommand({
    id: "table-add-row-after",
    label: "Insert new row below",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-Shift-ArrowDown" },
    palette: false,
  }),
  registerCommand({
    id: "table-add-col-before",
    label: "Insert new column left",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-Shift-ArrowLeft" },
    palette: false,
  }),
  registerCommand({
    id: "table-add-col-after",
    label: "Insert new column right",
    group: "Tables",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-Shift-ArrowRight" },
    palette: false,
  }),
  registerCommand({
    id: "selection-undo",
    label: "Undo selection",
    group: "Selection",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-u" },
    palette: false,
  }),
  registerCommand({
    id: "selection-redo",
    label: "Redo selection",
    group: "Selection",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-u", mac: "Mod-Shift-u" },
    palette: false,
  }),
  registerCommand({
    id: "selection-line",
    label: "Select line",
    group: "Selection",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-l", mac: "Ctrl-l" },
    palette: false,
  }),
  registerCommand({
    id: "selection-parent-syntax",
    label: "Select parent syntax",
    group: "Selection",
    scope: "editor",
    when: "editorFocus",
    // Mod-i is Italic. Sublime Text expands the selection to the scope with
    // Mod-Shift-Space.
    defaultKeybinding: { key: "Mod-Shift-Space" },
    palette: false,
  }),
  registerCommand({
    id: "selection-indent",
    label: "Indent selection",
    group: "Selection",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-\\" },
    palette: false,
  }),
  registerCommand({
    id: "edit-toggle-comment",
    label: "Toggle line comment",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-/" },
    palette: false,
  }),
  registerCommand({
    id: "edit-toggle-block-comment",
    label: "Toggle block comment",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    // Mod-C is Mod-Shift-c, Insert comment. Shift-Alt-a is CodeMirror's key.
    defaultKeybinding: { key: "Shift-Alt-a" },
    palette: false,
  }),
  registerCommand({
    id: "edit-copy-as-html",
    label: "Copy as HTML",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-c" },
    palette: false,
    menuItems: ["menu.copy_html"],
  }),
  registerCommand({
    id: "edit-paste-as-plain",
    label: "Paste without style",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift-v" },
    palette: false,
    menuItems: ["menu.paste_plain"],
  }),
  registerCommand({
    id: "tr-zap-gremlins",
    label: "Zap Gremlins",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-strip-duplicate-spaces",
    label: "Strip duplicate spaces",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-sentence-case",
    label: "To sentence case",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-italics-to-quotes",
    label: "Italics to quotes",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-quotes-to-italics",
    label: "Quotes to italics",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-remove-line-breaks",
    label: "Remove excess line breaks",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-straighten-quotes",
    label: "Straighten quotes",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-quotes-to-magic",
    label: "Convert quotes to Magic Quotes",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-ensure-double-quotes",
    label: "Ensure double quotes",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-double-quotes-to-single",
    label: "Double quotes to single",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-single-quotes-to-double",
    label: "Single quotes to double",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-title-case",
    label: "To title case",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-emdash-add-spaces",
    label: "Em dash: add spaces",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "tr-emdash-remove-spaces",
    label: "Em dash: remove spaces",
    group: "Transformations",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
    palette: false,
  }),
  registerCommand({
    id: "misc-toggle-tab-focus",
    label: "Toggle tab key focus mode",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Ctrl-m", mac: "Shift-Alt-m" },
    palette: false,
  }),
  registerCommand({
    id: "previous-tab",
    label: "Switch to previous tab",
    group: "User Interface",
    scope: "window",
    when: "window",
    defaultKeybinding: { key: "Ctrl-Shift-Tab" },
    palette: false,
    menuItems: ["menu.tab_previous"],
  }),
  registerCommand({
    id: "next-tab",
    label: "Switch to next tab",
    group: "User Interface",
    scope: "window",
    when: "window",
    defaultKeybinding: { key: "Ctrl-Tab" },
    palette: false,
    menuItems: ["menu.tab_next"],
  }),
  registerCommand({
    id: "filter-files",
    label: "Search files",
    group: "User Interface",
    scope: "window",
    when: "window",
    // Mod-Shift-p is Go to file.
    defaultKeybinding: { key: "Mod-Alt-p" },
    palette: false,
    menuItems: ["menu.filter_files"],
  }),
  ...windowCommands(),
] as const;

/**
 * The commands of the application menu. Each runs from its menu item; the
 * key of the item is the key of the command.
 */
function windowCommands() {
  const command = <const Id extends string, const Group extends CommandGroup>(
    id: Id,
    label: string,
    group: Group,
    defaultKeybinding: DefaultShortcut,
    menuItems: readonly string[],
  ) =>
    registerCommand({
      id,
      label,
      group,
      scope: "window",
      when: "window",
      defaultKeybinding,
      palette: false,
      menuItems,
    });
  const platformKey = <const Id extends string>(
    id: Id,
    label: string,
    defaultKeybinding: DefaultShortcut,
    menuItems: readonly string[],
  ) =>
    registerCommand({
      id,
      label,
      group: "Editing",
      scope: "window",
      when: "window",
      defaultKeybinding,
      palette: false,
      menuItems,
      fixed: true,
    });
  return [
    command("new-file", "New file", "File", { key: "Mod-n" }, ["menu.new_file"]),
    command("open-file", "Open file…", "File", { key: "Mod-o" }, ["menu.open"]),
    command("open-workspace", "Open workspace…", "File", { key: "Mod-Shift-o" }, [
      "menu.open_workspace",
    ]),
    command("save-file", "Save", "File", { key: "Mod-s" }, ["menu.save"]),
    command("export-file", "Export…", "File", { key: "Mod-e" }, ["menu.export"]),
    command("open-preferences", "Preferences…", "File", { key: "Mod-," }, ["menu.preferences"]),
    command("open-assets-manager", "Assets manager", "File", { key: "Mod-Alt-," }, [
      "menu.assets_manager",
    ]),
    command("rename-file", "Rename file…", "File", { key: "Mod-r" }, ["menu.rename_file"]),
    // Linux and Windows have no key: the file manager takes no key for a
    // removal.
    command("delete-file", "Delete file", "File", { mac: "Mod-Backspace" }, ["menu.delete_file"]),
    command("quit", "Quit", "File", { key: "Mod-q" }, ["menu-quit"]),
    command("find-in-workspace", "Find in workspace", "Search", { key: "Mod-Shift-f" }, [
      "menu.find_dir",
    ]),
    command("generate-id", "Generate new ID", "Editing", { key: "Mod-l" }, ["menu.generate_id"]),
    command("copy-id", "Copy ID of the file", "Editing", { key: "Mod-Shift-l" }, ["menu.copy_id"]),
    command("open-command-launcher", "Command launcher…", "View", { key: "Mod-p" }, [
      "menu.command_launcher",
    ]),
    command("open-file-launcher", "Go to file…", "View", { key: "Mod-Shift-p" }, [
      "menu.file_launcher",
    ]),
    // Mod-Alt-l is Format document.
    command("toggle-theme", "Toggle dark mode", "View", { key: "Mod-Alt-d" }, [
      "menu.toggle_theme",
    ]),
    command("toggle-file-meta", "Toggle file information", "View", { key: "Mod-Alt-s" }, [
      "menu.toggle_file_meta",
    ]),
    command("toggle-distraction-free", "Distraction-free mode", "View", { key: "Mod-j" }, [
      "menu.toggle_distraction_free",
    ]),
    command("toggle-typewriter-mode", "Typewriter mode", "View", { key: "Mod-Alt-t" }, [
      "menu.toggle_typewriter_mode",
    ]),
    command("toggle-navigation-sidebar", "Toggle the sidebar", "View", { key: "Mod-!" }, [
      "menu.toggle_navigation_sidebar",
    ]),
    command("show-problems", "Show problems", "View", { key: "Mod-Shift-m" }, [
      "menu.problems_reveal",
    ]),
    command("toggle-annotation-panel", "Toggle annotations", "View", { key: "Mod-Shift-0" }, [
      "menu.toggle_annotation_panel",
    ]),
    command("reset-zoom", "Reset zoom", "View", { key: "Mod-0" }, ["menu.reset_zoom"]),
    command("zoom-in", "Zoom in", "View", { key: "Mod-+" }, ["menu.zoom_in"]),
    command("zoom-out", "Zoom out", "View", { key: "Mod--" }, ["menu.zoom_out"]),
    command("toggle-fullscreen", "Toggle full screen", "View", { key: "F11", mac: "Ctrl-Mod-f" }, [
      "menu.toggle_fullscreen",
    ]),
    command("reload-window", "Reload the window", "Debug", { key: "F5" }, ["menu.reload"]),
    // Mod-Alt-i is Insert image on Linux and Windows, Mod-Shift-i on macOS.
    command(
      "toggle-devtools",
      "Toggle developer tools",
      "Debug",
      { key: "Mod-Shift-i", mac: "Mod-Alt-i" },
      ["menu.toggle_devtools"],
    ),
    command("open-logs", "Open the logs", "Debug", { key: "Mod-Alt-Shift-l" }, ["menu.open_logs"]),
    // Ctrl-m is the tab focus mode of the editor on Linux and Windows.
    command("minimize-window", "Minimize", "Window", { mac: "Mod-m" }, ["menu.win_minimize"]),
    command("close-window", "Close the window", "Window", { key: "Mod-Shift-w" }, [
      "menu.win_close",
    ]),
    command("close-tab", "Close the tab", "Window", { key: "Mod-w" }, ["menu.tab_close"]),
    command("reopen-closed-tab", "Reopen the closed tab", "Window", { key: "Mod-Shift-t" }, [
      "menu.tab_reopen_closed",
    ]),
    command("new-window", "New window", "Window", { key: "Mod-Shift-n" }, ["menu.new_window"]),
    command("open-docs", "Documentation", "Help", { key: "F1" }, ["menu.docs"]),
    platformKey("undo", "Undo", { key: "Mod-z" }, ["menu.undo"]),
    platformKey("redo", "Redo", { key: "Mod-Shift-z" }, ["menu.redo"]),
    platformKey("cut", "Cut", { key: "Mod-x" }, ["menu.cut"]),
    platformKey("copy", "Copy", { key: "Mod-c" }, ["menu.copy"]),
    platformKey("paste", "Paste", { key: "Mod-v" }, ["menu.paste"]),
    platformKey("select-all", "Select all", { key: "Mod-a" }, ["menu.select_all"]),
    platformKey("hide", "Hide Zettlr", { mac: "Mod-h" }, ["menu.hide"]),
    platformKey("hide-others", "Hide others", { mac: "Mod-Alt-h" }, ["menu.hide_others"]),
  ];
}

type RegisteredCommand = (typeof registrations)[number];
export type CommandId = RegisteredCommand["id"];
export type EditorCommandId = Extract<RegisteredCommand, { scope: "editor" }>["id"];
export type WindowCommandId = Extract<RegisteredCommand, { scope: "window" }>["id"];
export type PlatformCommandId = Extract<RegisteredCommand, { fixed: true }>["id"];

const commandsById = new Map<string, RegisteredCommand>(
  registrations.map((command) => [command.id, command]),
);

/** The command of each menu item that names one. One item runs one command. */
const commandsByMenuItem = new Map<string, RegisteredCommand>();
for (const command of registrations) {
  const menuItems: readonly string[] | undefined =
    "menuItems" in command ? command.menuItems : undefined;
  for (const menuItem of menuItems ?? []) {
    const other = commandsByMenuItem.get(menuItem);
    if (other !== undefined) {
      throw new Error(
        `The menu item "${menuItem}" names two commands: "${other.id}" and "${command.id}".`,
      );
    }
    commandsByMenuItem.set(menuItem, command);
  }
}

export const commandRegistry = {
  all(): readonly RegisteredCommand[] {
    return registrations;
  },
  /** The commands that the author can bind: each but the keys of the platform. */
  bindable(): readonly RegisteredCommand[] {
    return registrations.filter((command) => !("fixed" in command));
  },
  get(id: CommandId): RegisteredCommand | undefined {
    return commandsById.get(id);
  },
};

export function isCommandId(value: string): value is CommandId {
  return commandsById.has(value);
}

export interface ShortcutConfig {
  editor: Record<string, string>;
  ui: Record<string, string>;
}

export function createShortcutConfig(): ShortcutConfig {
  const editor: Record<string, string> = {};
  const ui: Record<string, string> = {};
  for (const command of commandRegistry.bindable()) {
    const target = command.scope === "editor" ? editor : ui;
    target[command.id] = "";
  }
  return { editor, ui };
}

export function getConfiguredShortcut(
  id: CommandId,
  shortcuts: ShortcutConfig,
): string | undefined {
  const command = commandsById.get(id);
  if (command === undefined) {
    throw new Error(`No command is registered with id "${id}".`);
  }
  const configured =
    "fixed" in command
      ? undefined
      : command.scope === "editor"
        ? shortcuts.editor[id]
        : shortcuts.ui[id];
  return configured === undefined || configured.trim() === ""
    ? getDefaultKeybinding(id, { [id]: command.defaultKeybinding })
    : configured;
}

/**
 * The other commands whose key is the key of this command. A key that the
 * editor takes does not reach a window command, so the scope does not count:
 * two bindings conflict when they name one key on this platform
 * (`normalizeShortcut`: `Mod-C` is `Mod-Shift-c`).
 */
export function getCommandConflicts(id: CommandId, shortcuts: ShortcutConfig): CommandId[] {
  const shortcut = getConfiguredShortcut(id, shortcuts);
  if (shortcut === undefined) {
    return [];
  }
  const key = normalizeShortcut(shortcut, process.platform);
  return registrations
    .filter((candidate) => candidate.id !== id)
    .filter((candidate) => {
      const other = getConfiguredShortcut(candidate.id, shortcuts);
      return other !== undefined && normalizeShortcut(other, process.platform) === key;
    })
    .map((candidate) => candidate.id);
}

/** The command that a menu item runs, if the item runs a registered command. */
export function commandForMenuItem(menuItemId: string): CommandId | undefined {
  return commandsByMenuItem.get(menuItemId)?.id;
}

/** The Electron accelerator of a command: its configured key on this platform. */
export function commandAccelerator(id: CommandId, shortcuts: ShortcutConfig): string | undefined {
  return cmShortcutToElectron(getConfiguredShortcut(id, shortcuts));
}

/**
 * The Electron accelerator of a key of the platform (cut, copy, paste,
 * select all), which no configuration changes.
 */
export function platformAccelerator(id: PlatformCommandId): string | undefined {
  return commandAccelerator(id, { editor: {}, ui: {} });
}

export function registeredEditorKeybindings(
  shortcuts: ReadonlyArray<{ name: EditorCommandId; shortcut: string }>,
): KeyBinding[] {
  const editor: Record<string, string> = {};
  for (const shortcut of shortcuts) {
    editor[shortcut.name] = shortcut.shortcut;
  }
  const config: ShortcutConfig = { editor, ui: {} };
  return registrations.flatMap((command): KeyBinding[] => {
    if (command.scope !== "editor" || command.run === undefined) {
      return [];
    }
    const key = getConfiguredShortcut(command.id, config);
    return key === undefined ? [] : [{ key, run: command.run }];
  });
}

export function runRegisteredEditorCommand(id: CommandId, view: EditorView): boolean {
  const command = commandsById.get(id);
  if (command === undefined || command.scope !== "editor" || command.run === undefined) {
    throw new Error(`Command "${id}" has no registered editor handler.`);
  }
  return command.run(view);
}

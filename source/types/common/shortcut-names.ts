/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Shortcut names
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The names the main process sends a window over the
 *                  `shortcut` channel: every application-menu item that acts
 *                  inside a window sends one, and the window's handlers are
 *                  keyed by them. The editor commands are shortcut names too:
 *                  an Insert or Format menu item sends the command it runs.
 *
 * END HEADER
 */

/** The commands the Markdown editor runs by name (runCommand). */
export const EDITOR_COMMAND_NAMES = [
  "markdownComment",
  "markdownLink",
  "markdownImage",
  "insertFootnote",
  "markdownMakeTaskList",
  "createReferenceLabel",
  "markdownBold",
  "markdownItalic",
  "markdownCode",
  "markdownStrikethrough",
  "markdownHeading1",
  "markdownHeading2",
  "markdownHeading3",
  "markdownHeading4",
  "markdownHeading5",
  "markdownHeading6",
  "markdownBlockquote",
  "markdownBulletList",
  "markdownOrderedList",
  "toggleReadabilityMode",
  "toggleLintPanel",
] as const;

export type EditorCommandName = (typeof EDITOR_COMMAND_NAMES)[number];

export function isEditorCommandName(value: string): value is EditorCommandName {
  return EDITOR_COMMAND_NAMES.some((name) => name === value);
}

/** The window-level shortcut names the menu templates and the window provider send. */
export const WINDOW_SHORTCUT_NAMES = [
  "close-all-tabs",
  "close-window",
  "copy-as-html",
  "copy-current-id",
  "delete-file",
  "edit-ignore-rules",
  "edit-quicktex",
  "edit-snippets",
  "export",
  "filter-files",
  "fix-all-document",
  "fix-all-open",
  "fix-all-workspace",
  "global-search",
  "insert-id",
  "insert-pandoc-div",
  "insert-pandoc-span",
  "navigate-back",
  "navigate-forward",
  "new-dir",
  "next-tab",
  "open-command-launcher",
  "open-file-launcher",
  "open-file-browser-here",
  "open-file-externally",
  "open-terminal-here",
  "pandoc-quick-help",
  "paste-as-plain",
  "previous-tab",
  "problems-reveal",
  "print",
  "rename-file",
  "reopen-closed-tab",
  "save-file",
  "save-all",
  "save-all-and-close",
  "search",
  "toggle-annotation-panel",
  "toggle-distraction-free",
  "toggle-navigation-sidebar",
  "toggle-typewriter-mode",
] as const;

export type WindowShortcutName = (typeof WINDOW_SHORTCUT_NAMES)[number];

export type ShortcutName = WindowShortcutName | EditorCommandName;

/** The arguments of a message on the `shortcut` channel: the name. */
export type ShortcutBroadcast = [name: ShortcutName];

/**
 * The arguments of a message on the `insert-table` channel: the size of the
 * table that an item of Insert › Table names.
 */
export type InsertTableBroadcast = [size: { rows: number; cols: number }];

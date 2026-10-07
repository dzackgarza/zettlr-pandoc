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
import { type DefaultShortcut, getDefaultKeybinding } from "@common/util/shortcuts";

export const ANNOTATE_SELECTION_EVENT = "zettlr-annotate-selection";

export type CommandScope = "editor" | "window";
export type CommandWhen = "editorFocus" | "editorHasSelection" | "window";
export type CommandGroup =
  | "Autocomplete"
  | "Editing"
  | "Folding"
  | "Navigation"
  | "Search"
  | "Selection"
  | "Tables"
  | "Transformations"
  | "User Interface";

export interface CommandRegistration<Id extends string = string> {
  id: Id;
  label: string;
  group: CommandGroup;
  scope: CommandScope;
  when: CommandWhen;
  defaultKeybinding: DefaultShortcut;
  palette: boolean;
  run?: (view: EditorView) => boolean;
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
  }),
  registerCommand({
    id: "md-insert-image",
    label: "Insert image",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-i", mac: "Mod-Shift-i" },
    palette: false,
  }),
  registerCommand({
    id: "md-insert-footnote",
    label: "Insert footnote",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Alt-f", mac: "Mod-Alt-r" },
    palette: false,
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
  }),
  registerCommand({
    id: "md-italic",
    label: "Italic",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-i" },
    palette: false,
  }),
  registerCommand({
    id: "md-task-list",
    label: "Toggle task list",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-t" },
    palette: false,
  }),
  registerCommand({
    id: "md-comment",
    label: "Insert comment",
    group: "Editing",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift-c" },
    palette: false,
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
    defaultKeybinding: { key: "Mod-Shift-l" },
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
    id: "search-references",
    label: "Search references",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-p" },
    palette: false,
  }),
  registerCommand({
    id: "search-files",
    label: "Go to file",
    group: "Search",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Mod-Shift-p" },
    palette: false,
  }),
  registerCommand({
    id: "nav-history-back",
    label: "Go back in this pane's history",
    group: "Navigation",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-ArrowLeft", mac: "Ctrl-ArrowLeft" },
    palette: false,
  }),
  registerCommand({
    id: "nav-history-forward",
    label: "Go forward in this pane's history",
    group: "Navigation",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: { key: "Alt-ArrowRight", mac: "Ctrl-ArrowRight" },
    palette: false,
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
    defaultKeybinding: { key: "Mod-i" },
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
    id: "selection-all",
    label: "Select all",
    group: "Selection",
    scope: "editor",
    when: "editorFocus",
    defaultKeybinding: {},
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
    defaultKeybinding: { key: "Mod-C" },
    palette: false,
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
  }),
  registerCommand({
    id: "next-tab",
    label: "Switch to next tab",
    group: "User Interface",
    scope: "window",
    when: "window",
    defaultKeybinding: { key: "Ctrl-Tab" },
    palette: false,
  }),
  registerCommand({
    id: "filter-files",
    label: "Filter files",
    group: "User Interface",
    scope: "window",
    when: "window",
    defaultKeybinding: { key: "Ctrl-Shift-p", mac: "Cmd-Shift-p" },
    palette: false,
  }),
] as const;

type RegisteredCommand = (typeof registrations)[number];
export type CommandId = RegisteredCommand["id"];
export type EditorCommandId = Extract<RegisteredCommand, { scope: "editor" }>["id"];
export type WindowCommandId = Extract<RegisteredCommand, { scope: "window" }>["id"];

const commandsById = new Map<string, RegisteredCommand>(
  registrations.map((command) => [command.id, command]),
);

export const commandRegistry = {
  all(): readonly RegisteredCommand[] {
    return registrations;
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
  for (const command of registrations) {
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
  const configured = command.scope === "editor" ? shortcuts.editor[id] : shortcuts.ui[id];
  return configured === undefined || configured.trim() === ""
    ? getDefaultKeybinding(id, { [id]: command.defaultKeybinding })
    : configured;
}

export function getCommandConflicts(id: CommandId, shortcuts: ShortcutConfig): CommandId[] {
  const command = commandsById.get(id);
  if (command === undefined) {
    throw new Error(`No command is registered with id "${id}".`);
  }
  const shortcut = getConfiguredShortcut(id, shortcuts);
  if (shortcut === undefined) {
    return [];
  }
  return registrations
    .filter((candidate) => candidate.id !== id && candidate.scope === command.scope)
    .filter((candidate) => getConfiguredShortcut(candidate.id, shortcuts) === shortcut)
    .map((candidate) => candidate.id);
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

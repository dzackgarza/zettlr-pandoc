/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Default Keymap
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the default Zettlr keymap that is valid for every
 *                  CodeMirror editor. It combines a series of factory keymaps
 *                  that ship with CodeMirror in addition to custom commands
 *                  that Zettlr defines.
 *
 * END HEADER
 */

import {
  acceptCompletion,
  closeCompletion,
  deleteBracketPair,
  moveCompletionSelection,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  copyLineDown,
  copyLineUp,
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineBoundaryLeft,
  cursorLineBoundaryRight,
  cursorLineDown,
  cursorLineEnd,
  cursorLineStart,
  cursorLineUp,
  cursorMatchingBracket,
  cursorPageDown,
  cursorPageUp,
  cursorSyntaxLeft,
  cursorSyntaxRight,
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteLine,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
  deleteToLineEnd,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
  redo,
  redoSelection,
  selectAll,
  selectCharLeft,
  selectCharRight,
  selectDocEnd,
  selectDocStart,
  selectGroupLeft,
  selectGroupRight,
  selectLine,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectLineBoundaryLeft,
  selectLineBoundaryRight,
  selectLineDown,
  selectLineEnd,
  selectLineStart,
  selectLineUp,
  selectPageDown,
  selectPageUp,
  selectParentSyntax,
  selectSyntaxLeft,
  selectSyntaxRight,
  simplifySelection,
  splitLine,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
  transposeChars,
  undo,
  undoSelection,
} from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { type Extension } from "@codemirror/state";
import { type KeyBinding, keymap } from "@codemirror/view";
import {
  NAVIGATION_SHORTCUT_DEFAULTS,
  type NavigationShortcutConfig,
} from "@common/util/navigation-shortcuts";
import { abortSnippet, abortSnippetRemoveContent, nextSnippet } from "../autocomplete/snippets";
import {
  handleAutocorrectEnter,
  handleAutocorrectSpace,
  handleBackspace,
  handleQuote,
} from "../commands/autocorrect";
import { addNewFootnote, selectFootnoteBeforeDelete } from "../commands/footnotes";
import {
  customMoveLineDown,
  customMoveLineUp,
  maybeIndentList,
  maybeUnindentList,
} from "../commands/lists";
import {
  applyBold,
  applyComment,
  applyHighlight,
  applyItalic,
  applyTaskList,
  insertImage,
  insertLink,
  insertTabOrSpace,
} from "../commands/markdown";
import { removeLineBreaks } from "../commands/transforms/remove-line-breaks";
import { requestFormatDocument } from "../plugins/format-document-effect";
import { openReferenceSearch } from "../plugins/reference-search-effect";
import {
  addColAfter,
  addColBefore,
  moveNextCell,
  movePrevCell,
  swapNextCol,
  swapPrevCol,
} from "../table-editor/commands/columns";
import {
  addRowAfter,
  addRowBefore,
  moveNextRow,
  movePrevRow,
  swapNextRow,
  swapPrevRow,
} from "../table-editor/commands/rows";
import { alignTables } from "../table-editor/commands/tables";
import { copyAsHTML, pasteAsPlain } from "../util/copy-paste-cut";
import { navigateHistoryBack, navigateHistoryForward } from "../util/reference-navigation";

/**
 * The per-pane Back/Forward history bindings (issue #1 Phase 5, review A8):
 * built from the CONFIGURED combos, defaulting to the shared Alt-Left/
 * Alt-Right registry. The macOS Ctrl-Arrow platform variants apply only
 * while the matching default combo is in effect — a user-configured combo
 * binds identically on every platform.
 *
 * @param   {NavigationShortcutConfig}  navigation  The configured combos
 *
 * @return  {KeyBinding[]}                          The two history bindings
 */
export function navigationKeybindings(
  navigation: NavigationShortcutConfig = NAVIGATION_SHORTCUT_DEFAULTS,
): KeyBinding[] {
  return [
    {
      key: navigation.back,
      mac: navigation.back === NAVIGATION_SHORTCUT_DEFAULTS.back ? "Ctrl-ArrowLeft" : undefined,
      run: navigateHistoryBack,
      preventDefault: true,
    },
    {
      key: navigation.forward,
      mac:
        navigation.forward === NAVIGATION_SHORTCUT_DEFAULTS.forward ? "Ctrl-ArrowRight" : undefined,
      run: navigateHistoryForward,
      preventDefault: true,
    },
  ];
}

// Includes:
// * defaultKeymap
// * historyKeymap
// * closeBracketsKeymap
// * searchKeymap
export function defaultKeymap(navigation?: NavigationShortcutConfig): Extension {
  // TODO: Disable alignment commands until custom keymapping is implemented
  // const alignLeft = setAlignment('left')
  // const alignCenter = setAlignment('center')
  // const alignRight = setAlignment('right')
  return keymap.of([
    // completionKeymap
    { key: "Ctrl-Space", run: startCompletion },
    { key: "Escape", run: closeCompletion },
    { key: "ArrowDown", run: moveCompletionSelection(true) },
    { key: "ArrowUp", run: moveCompletionSelection(false) },
    { key: "PageDown", run: moveCompletionSelection(true, "page") },
    { key: "PageUp", run: moveCompletionSelection(false, "page") },
    { key: "Enter", run: acceptCompletion },

    // markdownKeymap

    // Adding Markdown syntax elements
    { key: "Mod-b", run: applyBold },
    { key: "Mod-i", run: applyItalic },
    { key: "Mod-k", run: insertLink },

    // Format the whole document with flowmark (issue #26). Dispatches a pure
    // effect; the renderer runs the actual IPC format (electron stays out of
    // the editor core so browser test bundles resolve).
    { key: "Mod-Alt-l", run: requestFormatDocument },
    { key: "Ctrl-Shift-h", run: applyHighlight },
    // NOTE: We have to do it like this, because the Mod-Shift-i is occupied on
    // Windows/Linux by the DevTools shortcut, and Mod-Alt-i is the same for Mac.
    { key: "Mod-Alt-i", mac: "Mod-Shift-i", run: insertImage },
    { key: "Mod-C", run: applyComment },
    { key: "Mod-Alt-f", mac: "Mod-Alt-r", run: addNewFootnote },

    // Overload Tab, depending on context (priority high->low)
    { key: "Tab", run: acceptCompletion },
    { key: "Tab", run: nextSnippet },
    { key: "Tab", run: moveNextCell, shift: movePrevCell },
    { key: "Tab", run: maybeIndentList, shift: maybeUnindentList },
    { key: "Tab", run: insertTabOrSpace },

    // Overload Enter
    { key: "Enter", run: handleAutocorrectEnter },
    { key: "Enter", run: moveNextRow, shift: movePrevRow },
    // If no replacement can be handled, the default should be newlineAndIndent
    { key: "Enter", run: insertNewlineContinueMarkup },
    { key: "Enter", run: insertNewlineAndIndent },

    // Overload Backspace
    { key: "Backspace", run: selectFootnoteBeforeDelete },
    { key: "Backspace", run: deleteMarkupBackward },
    // closeBracketsKeymap
    { key: "Backspace", run: deleteBracketPair },
    { key: "Backspace", run: handleBackspace },

    { key: "Escape", run: abortSnippet, shift: abortSnippetRemoveContent },
    { key: "Escape", run: closeSearchPanel },
    { key: "Space", run: handleAutocorrectSpace },

    { key: "Alt-ArrowUp", run: customMoveLineUp, shift: copyLineUp },
    { key: "Alt-ArrowDown", run: customMoveLineDown, shift: copyLineDown },
    { key: "Mod-t", run: applyTaskList },
    {
      key: "Mod-Shift-v",
      run: (view) => {
        pasteAsPlain(view);
        return true;
      },
    },
    {
      key: "Mod-Alt-c",
      run: (view) => {
        copyAsHTML(view);
        return true;
      },
    },
    { key: '"', run: handleQuote('"') },
    { key: "'", run: handleQuote("'") },

    // Now follows the original sharedKeymap to make the defaults available, but
    // with a lower priority, so that we can override anything in this keymap.
    // Custom key bindings for Zettlr
    { key: "Tab", run: indentMore, shift: indentLess },

    // historyKeymap, but with our own keyboard shortcuts
    { key: "Mod-z", run: undo, preventDefault: true },
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
    { key: "Mod-u", run: undoSelection, preventDefault: true },
    { key: "Alt-u", mac: "Mod-Shift-u", run: redoSelection, preventDefault: true },

    // searchKeymap
    { key: "Mod-f", run: openSearchPanel, scope: "editor search-panel" },
    // Workspace reference search (issue #1 Phase 3b): the freed Mod-P (the
    // print menu items keep working but no longer claim the accelerator).
    { key: "Mod-p", run: openReferenceSearch, preventDefault: true },
    {
      key: "F3",
      run: findNext,
      shift: findPrevious,
      scope: "editor search-panel",
      preventDefault: true,
    },
    {
      key: "Mod-g",
      run: findNext,
      shift: findPrevious,
      scope: "editor search-panel",
      preventDefault: true,
    },
    { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
    { key: "Mod-Shift-l", run: selectSelectionMatches },
    { key: "Mod-Alt-g", run: gotoLine },
    { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },

    // foldKeymap
    { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: foldCode },
    { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: unfoldCode },
    { key: "Ctrl-Alt-[", run: foldAll },
    { key: "Ctrl-Alt-]", run: unfoldAll },

    // Per-pane Back/Forward session-history navigation (issue #1 Phase 5).
    // KEYMAP REMAP: the issue contract requires Alt-ArrowLeft/Right as the
    // (configurable) navigation defaults, which previously ran
    // cursorSyntaxLeft/Right here. Those commands move to
    // Mod-Alt-ArrowLeft/Right (verified unbound in this keymap; the only
    // Mod-Alt bindings are i/f/c/g/\/j and Ctrl-Alt-[/]). The table editor's
    // Alt-ArrowLeft/Right column swaps are unaffected: table cell subviews
    // register Prec.highest(tableEditorKeymap(mainView))
    // (table-editor/subview.ts), which runs before this keymap inside a
    // table cell. The navigation commands return false in views without
    // editor metadata (window/leaf IDs), so non-main editors fall through.
    // The combos are configurable (review A8): the host passes the
    // editor.navigationShortcuts config at extension-build time.
    ...navigationKeybindings(navigation),

    // defaultKeymap (cursorSyntaxLeft/Right remapped from Alt-Arrow, see above)
    { key: "Mod-Alt-ArrowLeft", run: cursorSyntaxLeft, shift: selectSyntaxLeft },
    { key: "Mod-Alt-ArrowRight", run: cursorSyntaxRight, shift: selectSyntaxRight },

    { key: "Alt-ArrowUp", run: moveLineUp },
    { key: "Shift-Alt-ArrowUp", run: copyLineUp },

    { key: "Alt-ArrowDown", run: moveLineDown },
    { key: "Shift-Alt-ArrowDown", run: copyLineDown },

    { key: "Escape", run: simplifySelection },
    { key: "Mod-Enter", run: insertBlankLine },

    { key: "Alt-l", mac: "Ctrl-l", run: selectLine },
    { key: "Mod-i", run: selectParentSyntax, preventDefault: true },

    { key: "Mod-[", run: indentLess },
    { key: "Mod-]", run: indentMore },
    { key: "Mod-Alt-\\", run: indentSelection },

    { key: "Shift-Mod-k", run: deleteLine },

    { key: "Shift-Mod-\\", run: cursorMatchingBracket },

    { key: "Mod-/", run: toggleComment },
    { key: "Mod-C", run: toggleBlockComment },

    { key: "Ctrl-m", mac: "Shift-Alt-m", run: toggleTabFocusMode },

    // Modified emacs style keymap as taken from CodeMirror
    { mac: "Ctrl-b", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
    { mac: "Ctrl-f", run: cursorCharRight, shift: selectCharRight },

    { mac: "Ctrl-p", run: cursorLineUp, shift: selectLineUp },
    { mac: "Ctrl-n", run: cursorLineDown, shift: selectLineDown },

    { mac: "Ctrl-a", run: cursorLineStart, shift: selectLineStart },
    { mac: "Ctrl-e", run: cursorLineEnd, shift: selectLineEnd },

    { mac: "Ctrl-d", run: deleteCharForward },
    { mac: "Ctrl-h", run: deleteCharBackward },
    { mac: "Ctrl-k", run: deleteToLineEnd },
    { mac: "Ctrl-Alt-h", run: deleteGroupBackward },

    { mac: "Ctrl-o", run: splitLine },
    { mac: "Ctrl-t", run: transposeChars },

    { mac: "Ctrl-v", run: cursorPageDown },

    // Standard keymap
    { key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
    {
      key: "Mod-ArrowLeft",
      mac: "Alt-ArrowLeft",
      run: cursorGroupLeft,
      shift: selectGroupLeft,
      preventDefault: true,
    },
    {
      mac: "Cmd-ArrowLeft",
      run: cursorLineBoundaryLeft,
      shift: selectLineBoundaryLeft,
      preventDefault: true,
    },
    { key: "ArrowRight", run: cursorCharRight, shift: selectCharRight, preventDefault: true },
    {
      key: "Mod-ArrowRight",
      mac: "Alt-ArrowRight",
      run: cursorGroupRight,
      shift: selectGroupRight,
      preventDefault: true,
    },
    {
      mac: "Cmd-ArrowRight",
      run: cursorLineBoundaryRight,
      shift: selectLineBoundaryRight,
      preventDefault: true,
    },
    { key: "ArrowUp", run: cursorLineUp, shift: selectLineUp, preventDefault: true },
    { mac: "Cmd-ArrowUp", run: cursorDocStart, shift: selectDocStart },
    { mac: "Ctrl-ArrowUp", run: cursorPageUp, shift: selectPageUp },
    { key: "ArrowDown", run: cursorLineDown, shift: selectLineDown, preventDefault: true },
    { mac: "Cmd-ArrowDown", run: cursorDocEnd, shift: selectDocEnd },
    { mac: "Ctrl-ArrowDown", run: cursorPageDown, shift: selectPageDown },
    { key: "PageUp", run: cursorPageUp, shift: selectPageUp },
    { key: "PageDown", run: cursorPageDown, shift: selectPageDown },
    {
      key: "Home",
      run: cursorLineBoundaryBackward,
      shift: selectLineBoundaryBackward,
      preventDefault: true,
    },
    { key: "Mod-Home", run: cursorDocStart, shift: selectDocStart },
    {
      key: "End",
      run: cursorLineBoundaryForward,
      shift: selectLineBoundaryForward,
      preventDefault: true,
    },
    { key: "Mod-End", run: cursorDocEnd, shift: selectDocEnd },
    { key: "Enter", run: insertNewlineAndIndent, shift: insertNewlineAndIndent },
    { key: "Mod-a", run: selectAll },
    { key: "Backspace", run: deleteCharBackward, shift: deleteCharBackward },
    { key: "Delete", run: deleteCharForward },
    { key: "Mod-Backspace", mac: "Alt-Backspace", run: deleteGroupBackward },
    { key: "Mod-Delete", mac: "Alt-Delete", run: deleteGroupForward },
    { mac: "Mod-Backspace", run: deleteLineBoundaryBackward },
    { mac: "Mod-Delete", run: deleteLineBoundaryForward },

    // Table Editor Keys. These need to be the last, since they override some
    // commands and need to only run if nothing equivalently mapped can be run
    // within the corresponding cells.
    // TODO: Disable alignment commands until custom keymapping is implemented
    // { key: 'Ctrl-l', run: alignLeft, preventDefault: true },
    // { key: 'Ctrl-c', run: alignCenter, preventDefault: true },
    // { key: 'Ctrl-r', run: alignRight, preventDefault: true },
    { key: "Mod-Shift-a", run: (v) => alignTables(v, v.state.selection.main.head) },
    { key: "Alt-ArrowUp", run: swapPrevRow, shift: addRowBefore },
    { key: "Alt-ArrowDown", run: swapNextRow, shift: addRowAfter },
    { key: "Alt-ArrowRight", run: swapNextCol, shift: addColAfter },
    { key: "Alt-ArrowLeft", run: swapPrevCol, shift: addColBefore },
    { key: "Mod-Alt-j", run: removeLineBreaks },
  ]);
}

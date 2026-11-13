/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        defaultMenu function
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Contains a utility function to show a basic Markdown context
 *                  menu
 *
 * END HEADER
 */

import { type Diagnostic, forceLinting, forEachDiagnostic, setDiagnostics } from "@codemirror/lint";
import { type EditorView } from "@codemirror/view";
import { editMenuItems, editorCommandMenuItems } from "@common/commands/editing-menu-items";
import { trans } from "@common/i18n-renderer";
import showPopupMenu, {
  type AnyMenuItem,
} from "@common/modules/window-register/application-menu-helper";
import { reportError } from "@common/util/error-reporting";
import { showRefusal } from "@common/util/show-refusal";
import { type SyntaxNode } from "@lezer/common";
import { isProseCompletionPosition } from "../autocomplete/prose-dictionary";
import {
  extractLTSpellcheckSuggestionsFrom,
  isLanguageToolMisspelling,
} from "../diagnostics/language-tool-state";
import { copyAsHTML, pasteAsPlain } from "../util/copy-paste-cut";
import { editorCommandItem, roleItem, tableSubmenu, viewItem } from "./menu-accelerator";
import { getTransformSubmenu } from "./transform-items";

const ipcRenderer = window.ipc;
const suggestionCache = new Map<string, string[]>();

/**
 * Builds the user-facing action that appends a word/phrase to the configured
 * portable prose-completion file. A non-empty selection is used only when the
 * menu was opened inside it; otherwise the word under the click is the entry.
 */
export function proseCompletionMenuItem(view: EditorView, pos: number): AnyMenuItem | undefined {
  if (!isProseCompletionPosition(view.state, pos)) {
    return undefined;
  }

  const selection = view.state.selection.main;
  const selected =
    !selection.empty && selection.from <= pos && pos <= selection.to
      ? selection
      : view.state.wordAt(pos);
  const completionEntry =
    selected === null
      ? ""
      : view.state.sliceDoc(selected.from, selected.to).replace(/\s+/gu, " ").trim();
  if (completionEntry === "") {
    return undefined;
  }

  return {
    label: trans("Add to prose completion dictionary"),
    type: "normal",
    action() {
      ipcRenderer
        .invoke("dictionary-provider", {
          command: "add-prose-completion",
          payload: { entry: completionEntry },
        })
        .catch(showRefusal);
    },
  };
}

// Listen for dictionary-provider messages. NOTE: The suggestionCache is shared,
// meaning I'd have to implement it in a scope if I need custom
ipcRenderer.on("dictionary-provider", (event, message) => {
  const { command } = message;

  if (command === "invalidate-dict") {
    // Invalidate the buffered dictionary
    suggestionCache.clear();
  }
});

/**
 * Sanitizes a term so that the dictionary can find it (remove funky characters
 * and quotes, for example)
 *
 * @param   {string}  term  The unsanitized term
 *
 * @return  {string}        The sanitized term
 */
function sanitizeTerm(term: string): string {
  // Convert smart quotes into the default before checking the term, see #1948
  return term.replace(/’‘‚‹›»“”」/g, "'");
}

/**
 * Returns a list of suggestions. If none are cached locally, this will return
 * an empty list and start a fetch in the background.
 *
 * @param   {string}             term  The term to get suggestions for
 *
 * @return  {Promise<string[]>}        A list of possible suggestions
 */
async function fetchSuggestions(term: string): Promise<string[]> {
  const saneTerm = sanitizeTerm(term);
  const cachedSuggestions = suggestionCache.get(saneTerm);
  if (cachedSuggestions !== undefined) {
    return cachedSuggestions;
  }

  // If we're here, the suggestion has not yet been cached. Code is equal to
  // above's batchSuggest
  const suggestions: string[][] = await ipcRenderer.invoke("dictionary-provider", {
    command: "suggest",
    terms: [saneTerm],
  });

  suggestionCache.set(saneTerm, suggestions[0]);
  return suggestions[0];
}

/**
 * Shows a default context menu for the given node at the given coordinates in
 * the given view.
 *
 * @param   {EditorView}                view        The view
 * @param   {SyntaxNode}                node        The node
 * @param   {{ x: number, y: number }}  coords      The screen coordinates
 * @param   {AnyMenuItem[]}             extraItems  Contextual items prepended
 *                                                  to the default template
 *                                                  (e.g. the node-routed
 *                                                  "Create reference label…"
 *                                                  entry)
 */
export async function defaultMenu(
  view: EditorView,
  node: SyntaxNode,
  coords: { x: number; y: number },
  extraItems: AnyMenuItem[] = [],
): Promise<void> {
  // In this function, we're doing a lot of iffs to check if there is a
  // spellcheck underneath the cursor and, if there is, add suggestions (if
  // there are) to the context menu.
  const pos = view.posAtCoords(coords);

  const suggestions: string[] = [];
  let diagnostic: Diagnostic | undefined;
  let misspelledWord: string | undefined;

  if (pos !== null) {
    forEachDiagnostic(view.state, (diag, from, to) => {
      // We need a suggestion that's under the cursor and indicates a misspelling.
      // These can be produced both my LanguageTool and the Hunspell dictionaries.
      if (
        from <= pos &&
        to >= pos &&
        (diag.source === "spellcheck" || isLanguageToolMisspelling(diag))
      ) {
        diagnostic = diag;
      }
    });
  }

  // If we have a diagnostic, we can extract the word & select it
  if (diagnostic !== undefined) {
    misspelledWord = view.state.sliceDoc(diagnostic.from, diagnostic.to);
    view.dispatch({
      selection: { anchor: diagnostic.from, head: diagnostic.to },
    });
  }

  // If we have a word, we can fetch suggestions ...
  if (
    misspelledWord !== undefined &&
    diagnostic !== undefined &&
    isLanguageToolMisspelling(diagnostic)
  ) {
    const s = extractLTSpellcheckSuggestionsFrom(diagnostic);
    if (s !== null) {
      suggestions.push(...s);
    }
  } else if (misspelledWord !== undefined) {
    suggestions.push(...(await fetchSuggestions(misspelledWord)));
  }

  // ... and transform them to menu items
  const suggestionItems: AnyMenuItem[] = suggestions.map((suggestion) => {
    return {
      type: "normal",
      label: suggestion,
      action() {
        if (diagnostic === undefined) {
          console.warn("Could not apply suggestion: No diagnostic found");
          return;
        }

        view.dispatch({
          changes: { from: diagnostic.from, to: diagnostic.to, insert: suggestion },
        });
      },
    };
  });

  // If there are no suggestions, add an indication
  if (suggestionItems.length === 0) {
    suggestionItems.push({
      type: "normal",
      enabled: false,
      label: trans("No suggestions"),
      id: "no-suggestion",
    });
  }

  // Always add a separator afterwards and an add-to-dictionary before
  suggestionItems.push({ type: "separator" });
  suggestionItems.unshift(
    {
      label: trans("Add to dictionary"),
      type: "normal",
      action() {
        if (misspelledWord === undefined) {
          return; // The context menu was built without a word under the cursor
        }
        ipcRenderer
          .invoke("dictionary-provider", { command: "add", terms: [misspelledWord] })
          .then(() => {
            // After we've added the word to the dictionary, we have to invalidate
            // the external spelling diagnostics that mark this word as wrong.
            const filteredDiagnostics: Diagnostic[] = [];
            forEachDiagnostic(view.state, (d, from, to) => {
              if (d.source !== "spellcheck" && !isLanguageToolMisspelling(d)) {
                filteredDiagnostics.push(d);
              } else if (view.state.sliceDoc(from, to) !== misspelledWord) {
                filteredDiagnostics.push(d);
              }
            });
            view.dispatch(setDiagnostics(view.state, filteredDiagnostics));
            forceLinting(view);
          })
          .catch((e) => reportError(e));
      },
    },
    { type: "separator" },
  );

  const items = editorCommandMenuItems(trans);
  const edit = editMenuItems(trans);
  const tpl: AnyMenuItem[] = [
    editorCommandItem(view, items.bold),
    editorCommandItem(view, items.italic),
    { type: "separator" },
    editorCommandItem(view, items.link),
    editorCommandItem(view, items.bulletList),
    editorCommandItem(view, items.orderedList),
    editorCommandItem(view, items.taskList),
    editorCommandItem(view, items.blockquote),
    tableSubmenu(view),
    { type: "separator" },
    roleItem(view, edit.cut),
    roleItem(view, edit.copy),
    viewItem(view, edit.copyAsHtml, copyAsHTML),
    roleItem(view, edit.paste),
    viewItem(view, edit.pasteAsPlain, pasteAsPlain),
    { type: "separator" },
    roleItem(view, edit.selectAll),
    { type: "separator" },
    getTransformSubmenu(view),
  ];

  const addProseCompletion = pos === null ? undefined : proseCompletionMenuItem(view, pos);
  if (addProseCompletion !== undefined) {
    tpl.unshift(addProseCompletion, { type: "separator" });
  }

  // If we found a diagnostic earlier and a word, add the suggestion items
  if (diagnostic !== undefined && misspelledWord !== undefined) {
    tpl.unshift(...suggestionItems);
  }

  // Contextual node-routed items lead the menu
  if (extraItems.length > 0) {
    tpl.unshift(...extraItems, { type: "separator" });
  }

  showPopupMenu(coords, tpl);
}

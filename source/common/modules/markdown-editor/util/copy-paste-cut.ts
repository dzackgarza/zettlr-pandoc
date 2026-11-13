/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Copy as HTML and Paste without style
 * CVM-Role:        Utility Functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Copy as HTML and Paste without style of the editor. Cut,
 *                  Copy and Paste are the clipboard events of the editor
 *                  (the Edit menu roles, the keys of the platform).
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";
import { md2html } from "@common/modules/markdown-utils";
import { reportError } from "@common/util/error-reporting";
import showToast from "@common/util/show-toast";
import { configField } from "./configuration";

/**
 * Copies whatever is currently selected into the clipboard as HTML (with plain
 * text fallback)
 *
 * @param   {EditorView}  view  The view
 */
export function copyAsHTML(view: EditorView): void {
  const { library } = view.state.field(configField).metadata;
  const selections: string[] = [];

  for (const { from, to } of view.state.selection.ranges) {
    selections.push(view.state.sliceDoc(from, to));
  }

  const { zknLinkFormat } = view.state.field(configField);

  const plainText = selections.join("\n");
  md2html(plainText, { onCitation: window.getCitationCallback(library), zknLinkFormat })
    .then(
      async (html) =>
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plainText], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]),
    )
    .then(undefined, (failure: Error) => {
      // The author pressed the key and the clipboard holds nothing new: say why.
      reportError("Copy as HTML failed", failure);
      showToast(trans("Copy as HTML failed: %s", failure.message), "error", 12000);
    });
}

/**
 * Explicitly paste the plain text from the clipboard.
 *
 * @param   {EditorView}  view  The view
 */
export function pasteAsPlain(view: EditorView): void {
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text !== "") {
        view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true });
      }
    })
    .catch((err) => reportError(err));
}

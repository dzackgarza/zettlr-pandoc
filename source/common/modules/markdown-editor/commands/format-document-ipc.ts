/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IPC-backed flowmark formatter (issue #26)
 * CVM-Role:        Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The renderer half of the flowmark "Format document"
 *                  command: the production MarkdownFormatter routes buffer text
 *                  through the main-process flowmark service over the
 *                  'application' IPC channel, and a helper surfaces a typed
 *                  absence or error as a toast (never a silent no-op). This
 *                  module reaches `window.ipc` (the contextBridge bridge), so it
 *                  must ONLY be imported from the renderer (MainEditor.vue) —
 *                  never from the shared editor core that browser test bundles
 *                  reach. The keystroke path runs through the pure
 *                  formatDocumentEffect instead.
 *
 * END HEADER
 */

import showToast from "@common/util/show-toast";
import { type FormatResult, type MarkdownFormatter } from "./format-document";

const ipcRenderer = window.ipc;

/**
 * The production formatter: sends the buffer text to the main-process flowmark
 * service and returns its typed result.
 */
export const ipcMarkdownFormatter: MarkdownFormatter = async (text) => {
  return (await window.ipc.invoke("application", {
    command: "format-document",
    payload: text,
  })) as FormatResult;
};

/** Surfaces a failed format to the user as a toast; a success is silent. */
export function surfaceFormatResult(result: FormatResult): void {
  if (result.ok) {
    return;
  }

  if (result.kind === "flowmark-absent") {
    showToast(
      "flowmark is not available — install it (uvx) to format documents. The document was not changed.",
      "error",
    );
  } else {
    showToast(`flowmark could not format the document: ${result.message}`, "error");
  }
}

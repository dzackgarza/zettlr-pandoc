/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        formatDocumentEffect (issue #26)
 * CVM-Role:        Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A pure CodeMirror effect + keymap command that REQUESTS a
 *                  document format, mirroring reference-search-effect. The
 *                  keymap lives in the shared editor core, which browser test
 *                  bundles reach, so it must stay free of any `electron` import.
 *                  MarkdownEditor re-emits this effect as a 'format-document'
 *                  event; only the renderer (MainEditor.vue) — where electron is
 *                  available — runs the actual flowmark IPC format in response.
 *
 * END HEADER
 */

import { StateEffect } from "@codemirror/state";
import { type Command } from "@codemirror/view";

export const formatDocumentEffect = StateEffect.define<null>();

/** Keymap command: requests a document format via the shared effect. */
export const requestFormatDocument: Command = (view) => {
  view.dispatch({ effects: formatDocumentEffect.of(null) });
  return true;
};

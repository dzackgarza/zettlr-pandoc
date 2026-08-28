/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CodeMirror Vim
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file is responsible for extending the Vim mode API, and
 *                  providing an extension that can be used in the input
 *                  compartments. NOTE that this only works in MainEditor
 *                  instances, not code editors, since the latter don't provide
 *                  the required state fields.
 *
 * END HEADER
 */

import type { Extension } from "@codemirror/state";
import { trans } from "@common/i18n-renderer";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast from "@common/util/show-toast";
import { type CodeMirror, type ExParams, Vim, vim } from "@replit/codemirror-vim";
import { configField } from "../util/configuration";
import { editorMetadataFacet } from "./editor-metadata";

const ipcRenderer = window.ipc;

/**
 * Sends a save-request to the main process.
 *
 * Resolves with whether the file is now on disk, so `:wq` can decide whether
 * closing is safe. A refused save must not be reported as `true`: the provider
 * refuses precisely in the states where closing would lose the buffer.
 *
 * @param   {CodeMirror}       cm       Replit's CodeMirror object
 * @param   {ExParams}         _params  Any params to the command
 *
 * @return  {Promise<boolean>}          Whether the save landed
 */
async function write(cm: CodeMirror, _params: ExParams): Promise<boolean> {
  // No probe around the field read: a missing configField means this editor was
  // built without the MainEditor state fields, which is a wiring error, not a
  // save outcome. Reporting it as "did not save" would let `:wq` treat a broken
  // editor the same as a refused write. `quit` reads the field the same way.
  const filePath = cm.cm6.state.field(configField).metadata.path;

  return await ipcRenderer
    .invoke("documents:save-file", { path: filePath })
    .then((result) => {
      if (result.ok) {
        return true;
      }
      // `:w` is a save request like any other, so it gets the same treatment as
      // the Save shortcut in MainEditor: the provider hands back the reason it
      // refused, and we surface it on the closable toast rather than dropping it
      // into the console where nobody sees it.
      const message =
        result.refusal?.message ?? trans('Could not save "%s".', pathBasename(filePath));
      console.error(
        `[vim :w] Main refused to save ${filePath}` +
          (result.refusal !== undefined
            ? ` (${result.refusal.reason}): ${result.refusal.message}`
            : ""),
      );
      showToast(message, "error", 12000);
      return false;
    })
    .catch((e) => {
      console.error(e);
      return false;
    });
}

/**
 * Sends a close-file command to the main process.
 *
 * @param   {CodeMirror}       cm       Replit's CodeMirror object
 * @param   {ExParams}         _params  Any params to the command
 *
 * @return  {Promise<void>}             Returns the IPC promise
 */
async function quit(cm: CodeMirror, _params: ExParams): Promise<void> {
  // Grab the required information from the editor state
  const filePath = cm.cm6.state.field(configField).metadata.path;
  const { leafId, windowId } = cm.cm6.state.facet(editorMetadataFacet);

  if (leafId === undefined || windowId === undefined) {
    throw new Error("Cannot close file: Leaf or Window ID were empty!");
  }

  // Request closing of the editor with main
  await ipcRenderer
    .invoke("documents-provider", {
      command: "close-file",
      payload: {
        path: filePath,
        windowId: windowId,
        leafId: leafId,
      },
    })
    .catch((e) => console.error(e));
}

// replit's API seems a bit less elegant than the CodeMirror one, but I think
// this is because they also need to support older CM5 setups.
// defineEx expects a void-returning command, so the promise is explicitly
// discarded here: both functions already surface their own failures.
Vim.defineEx("quit", "q", (cm: CodeMirror, params: ExParams) => {
  void quit(cm, params);
});
Vim.defineEx("write", "w", (cm: CodeMirror, params: ExParams) => {
  void write(cm, params);
});
Vim.defineEx("wq", "wq", (cm: CodeMirror, params: ExParams) => {
  // To prevent closing a file before it is written (and, thus, risking a prompt
  // to the user), we wait until the invocation is done and only then request a
  // close of the file. A refused save leaves the file open: the provider refuses
  // when the buffer holds an unresolved review, a report the pane never
  // delivered, or an external edit — in every one of those states, closing the
  // file is how the unsaved buffer gets lost. `write` has already surfaced the
  // reason on a toast, so the user sees why `:wq` stopped at `:w`.
  write(cm, params)
    .then((saved) => {
      if (!saved) {
        return;
      }
      quit(cm, params).catch((err) => console.error(err));
    })
    .catch((err) => console.error(err));
});

// Remap movement keys
// @ts-expect-error The types are not properly updated
Vim.map("j", "gj"); // Account for line wraps when moving down
// @ts-expect-error The types are not properly updated
Vim.map("k", "gk"); // Account for line wraps when moving up

// Map s and S, which "should" work out of the box with CM-vim.
// See https://github.com/Zettlr/Zettlr/issues/6431-4892471526
// @ts-expect-error The types are not properly updated
Vim.map("s", "cl"); // Add missing substitute-character command
// @ts-expect-error The types are not properly updated
Vim.map("S", "cc"); // Add missing substitute-line command

// Unmap bindings to restore default editor behavior
// @ts-expect-error The types are not properly updated
Vim.unmap("<C-f>"); // Allow invoking Ctrl+F search from all modes
Vim.unmap("<C-t>", "insert"); // Allow task item shortcut in Insert mode
Vim.unmap("<C-c>", "insert"); // Allow using Ctrl+C without exiting Insert mode

// Why do we do this, even though it seems somewhat pointless? Well, first to
// ensure that we have a central place where we modify the Vim extension, and
// two, in case we can actually provide extensions inside the state here, we
// have everything set up. Also, this prevents registering multiple Ex's here.
export function vimPlugin(): Extension {
  return [vim()];
}

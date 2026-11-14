/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        saveBuffer
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Writes an editor buffer to disk through the document
 *                  authority, after the authority holds every byte of it.
 *
 * END HEADER
 */

import type { EditorState } from "@codemirror/state";
import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import { saveRefusalActions } from "@common/util/save-refusal-action";
import showToast from "@common/util/show-toast";
import type { SaveFileResult } from "@dts/common/documents";
import { whenAuthoritySynced } from "./when-authority-synced";

/**
 * Saves the document at `filePath` and resolves with whether it is now on disk.
 *
 * `documents:save-file` writes the text that the document authority in main
 * holds. The editor sends typed text to the authority in collab batches, so
 * the last keystrokes before a save can still be unsent. The save therefore
 * waits until the authority has confirmed every update of the buffer. When
 * that wait fails, nothing is written: a write then would put older text on
 * disk and report success. The unsent updates stay in the buffer, and a second
 * save tries again; when the editor loaded the document again during the wait,
 * the updates are gone with the old state. The message names which.
 *
 * A refusal from the provider (an unresolved review, an external edit) is
 * shown on the closable toast, not in a main-process modal, which would block
 * the app until dismissed. The toast has the message of the refusal, which
 * names the cause, and the action that resolves the refusal when one exists.
 * A request that fails is shown with its error.
 *
 * @param   {() => EditorState}  getState  Reads the current editor state.
 * @param   {string}             filePath  The document to save.
 *
 * @return  {Promise<boolean>}             Whether the save landed.
 */
export async function saveBuffer(getState: () => EditorState, filePath: string): Promise<boolean> {
  try {
    await whenAuthoritySynced(getState);
  } catch (error) {
    reportError(`[saveBuffer] ${filePath} was NOT saved`, error);
    showToast(
      trans(
        'Could not save "%s"; nothing was written. %s',
        pathBasename(filePath),
        error instanceof Error ? error.message : String(error),
      ),
      "error",
      12000,
    );
    return false;
  }

  let result: SaveFileResult;
  try {
    result = await window.ipc.invoke("documents:save-file", { path: filePath });
  } catch (error) {
    reportError(`[saveBuffer] The save request for ${filePath} failed`, error);
    showToast(
      trans(
        'Could not save "%s": %s',
        pathBasename(filePath),
        error instanceof Error ? error.message : String(error),
      ),
      "error",
      12000,
    );
    return false;
  }
  if (result.ok) {
    return true;
  }
  const { refusal } = result;
  reportError(
    `[saveBuffer] Main refused to save ${filePath} (${refusal.reason}): ${refusal.message}`,
  );
  showToast(refusal.message, "error", 12000, ...saveRefusalActions(filePath, refusal));
  return false;
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        whenAuthoritySynced
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Waits until the document authority holds every byte the
 *                  editor buffer holds, and fails when it does not.
 *
 * END HEADER
 */

import { getClientID, sendableUpdates } from "@codemirror/collab";
import type { EditorState } from "@codemirror/state";

/**
 * Resolves once the editor state has no sendable collab updates left, i.e. the
 * document authority in main has confirmed every change the buffer carries.
 * Throws once `timeout` ms have passed with updates still unsent.
 *
 * The throw is the point. Callers order a format-then-save on this wait: the
 * on-disk write goes through the authority, so it can only see the formatted
 * bytes once the format's update has arrived there. Returning on the backstop
 * would report a guarantee that was not met, the save would then write the
 * pre-format text, and the author would be told the file saved fine — a
 * difference they could only find by diffing the file. Failing instead costs
 * nothing: the unsent updates stay in the buffer and the remote-doc push loop
 * keeps retrying, so the caller can refuse the save, say so, and let the author
 * press save again.
 *
 * The wait follows one collab session: the client id of the state at its
 * start (each `collab()` extension has its own). When the editor loads the
 * document again while updates are unsent (a lost synchronization, a setting
 * change, a kept remote change), the new state has a new session over the
 * text of the authority and nothing to send. The unsent updates are gone, not
 * confirmed, so the wait throws.
 *
 * @param   {() => EditorState}  getState  Reads the current editor state. It is
 *                                         a callback because the state is
 *                                         replaced while we wait.
 * @param   {number}             timeout   Backstop in ms.
 *
 * @return  {Promise<void>}                Resolves only when nothing is unsent.
 */
export async function whenAuthoritySynced(
  getState: () => EditorState,
  timeout = 2000,
): Promise<void> {
  const start = Date.now();
  const session = getClientID(getState());
  let unsent = sendableUpdates(getState()).length;

  while (unsent > 0) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      throw new Error(
        `The document has not taken ${unsent} change(s) of the editor after ` +
          `${elapsed} ms. The editor sends them again; save again to write them.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    const state = getState();
    if (getClientID(state) !== session) {
      throw new Error(
        `The editor loaded the document again before the document took ` +
          `${unsent} change(s) of the editor. The editor shows the text of the ` +
          `document now, without those changes.`,
      );
    }
    unsent = sendableUpdates(state).length;
  }
}

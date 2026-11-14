/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showRefusalInWindow
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Shows the refusal of a request of a window in that window.
 *
 * END HEADER
 */

import { sendIPCMessage } from "@common/util/broadcast-ipc-message";
import errorToString from "@common/util/error-to-string";
import { COMMAND_FAILED_CHANNEL, type CommandFailedBroadcast } from "@dts/common/command-failure";
import type { WebContents } from "electron";

/**
 * Sends the refusal of a request to the window that made it, which shows the
 * message one time (`window-register`). The caller in the window logs the
 * rejection and stops (AGENTS.md §15). A window without a renderer gets
 * nothing (§17). The message is the message of the error, without its stack.
 */
export function showRefusalInWindow(window: WebContents, request: string, error: unknown): void {
  if (window.isDestroyed() || window.isCrashed()) {
    return;
  }
  const message = error instanceof Error ? error.message : errorToString(error);
  const failure: CommandFailedBroadcast = { command: request, message };
  sendIPCMessage(window, COMMAND_FAILED_CHANNEL, failure);
}

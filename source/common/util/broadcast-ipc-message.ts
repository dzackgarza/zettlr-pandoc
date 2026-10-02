/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        broadcastIPCMessage
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file enables anything in the main process to broadcast
 *                  an IPC message to every single browser window that is
 *                  currently open.
 *
 * END HEADER
 */

import type { Cloneable, IpcArgument } from "@dts/common/ipc";
import { BrowserWindow } from "electron";

/**
 * Broadcasts an IPC message to all open windows
 *
 * @param   {string}  channel  The channel to broadcast on
 * @param   {Array}   args     The arguments of the message; IPC must be able to carry each
 */
export default function broadcastIPCMessage<A extends readonly IpcArgument[]>(
  channel: string,
  ...args: A & Cloneable<A>
): void {
  const allWindows = BrowserWindow.getAllWindows();

  for (const window of allWindows) {
    window.webContents.send(channel, ...args);
  }
}

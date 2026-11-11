/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        tellMainWindows
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Sends an IPC message to the main windows that an event
 *                  concerns, where broadcastIPCMessage sends it to every
 *                  window. A message that only the author can act on goes to
 *                  one place: a second window with the same message is a
 *                  second message.
 *
 * END HEADER
 */

import type { Cloneable, IpcArgument } from "@dts/common/ipc";
import type { BrowserWindow } from "electron";

/** A window without a renderer has nothing that receives a message. */
function hasRenderer(window: BrowserWindow | undefined): window is BrowserWindow {
  return window !== undefined && !window.webContents.isCrashed();
}

/**
 * Sends a message to each of `addressed` that has a working renderer. When
 * none of them has one, `lastUsed` gets the message: the main window that the
 * author used last.
 *
 * @param   {Array}          addressed  The main windows that the event concerns; undefined for a window that is gone
 * @param   {BrowserWindow}  lastUsed   The main window that the author used last
 * @param   {string}         channel    The channel of the message
 * @param   {Array}          args       The arguments of the message; IPC must be able to carry each
 */
export default function tellMainWindows<A extends readonly IpcArgument[]>(
  addressed: ReadonlyArray<BrowserWindow | undefined>,
  lastUsed: BrowserWindow | undefined,
  channel: string,
  ...args: A & Cloneable<A>
): void {
  const named = addressed.filter(hasRenderer);
  const receivers = named.length > 0 ? named : [lastUsed].filter(hasRenderer);
  for (const window of receivers) {
    window.webContents.send(channel, ...args);
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        broadcastIPCMessage, sendIPCMessage, replyIPCMessage
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file enables anything in the main process to send an
 *                  IPC message to a window: to every window that is open
 *                  (broadcastIPCMessage), to one window or frame
 *                  (sendIPCMessage), or as the answer to a message of a
 *                  window (replyIPCMessage). The channel and its arguments
 *                  are those that IpcBroadcastContracts
 *                  (source/types/renderer/ipc-bridge.ts) declares, which are
 *                  the arguments that a listener of window.ipc.on gets.
 *
 * END HEADER
 */

import type { IpcBroadcastArgs, IpcBroadcastContracts } from "@dts/renderer/ipc-bridge";
import { BrowserWindow, type IpcMainEvent, type WebContents, type WebFrameMain } from "electron";

/** A window or a frame that a message can go to. */
export type IpcMessageTarget = Pick<WebContents, "send"> | Pick<WebFrameMain, "send">;

/**
 * Broadcasts an IPC message to all open windows
 *
 * @param   {string}  channel  The channel to broadcast on; a channel of IpcBroadcastContracts
 * @param   {Array}   args     The arguments that the table declares for the channel
 */
export default function broadcastIPCMessage<C extends keyof IpcBroadcastContracts>(
  channel: C,
  ...args: IpcBroadcastArgs<C>
): void {
  const allWindows = BrowserWindow.getAllWindows();

  for (const window of allWindows) {
    // A window whose renderer ended has nothing that receives a message.
    // The window reads the whole state when it loads again.
    if (window.webContents.isCrashed()) {
      continue;
    }
    window.webContents.send(channel, ...args);
  }
}

/**
 * Sends an IPC message to one window or frame.
 *
 * @param   {IpcMessageTarget}  target   The web contents or the frame that gets the message
 * @param   {string}            channel  A channel of IpcBroadcastContracts
 * @param   {Array}             args     The arguments that the table declares for the channel
 */
export function sendIPCMessage<C extends keyof IpcBroadcastContracts>(
  target: IpcMessageTarget,
  channel: C,
  ...args: IpcBroadcastArgs<C>
): void {
  target.send(channel, ...args);
}

/**
 * Answers a message of a window: the frame that sent `event` gets the
 * message.
 *
 * @param   {IpcMainEvent}  event    The message of the window
 * @param   {string}        channel  A channel of IpcBroadcastContracts
 * @param   {Array}         args     The arguments that the table declares for the channel
 */
export function replyIPCMessage<C extends keyof IpcBroadcastContracts>(
  event: Pick<IpcMainEvent, "reply">,
  channel: C,
  ...args: IpcBroadcastArgs<C>
): void {
  event.reply(channel, ...args);
}

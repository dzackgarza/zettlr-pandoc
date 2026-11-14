/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Typed invoke of the main-process IPC handlers
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A spec sends a message to a handler that a REAL provider
 *                  registered with the headless harness, as window.ipc.invoke
 *                  of a renderer does. The type is the one of the renderer
 *                  (`ZettlrIpcInvoke`, source/types/renderer/ipc-bridge.ts),
 *                  composed from the contract beside each handler: a wrong
 *                  channel, command or payload does not compile, and the
 *                  answer has the type of the contract (#91). A spec must
 *                  import the headless Electron harness before this.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { ipcMainHandlers } from "./headless-electron-harness.cjs";

/**
 * Calls the handler of a channel with the arguments of the message. The
 * handlers that the specs call read nothing of the event, so the event is
 * an empty object.
 */
export const invokeMain: ZettlrIpcInvoke = async (channel: string, ...message: unknown[]) => {
  const handler = ipcMainHandlers.get(channel);
  assert.ok(handler !== undefined, `no provider registered a handler for "${channel}"`);
  return await handler({}, ...message);
};

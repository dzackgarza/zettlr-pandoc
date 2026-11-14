/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        handleInvokeChannel, handleFixedChannel, handleBareChannel,
 *                  handleBareChannelOnce
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The main-process side of window.ipc.invoke. Each function
 *                  registers the handler of one invoke channel with the
 *                  types of the channel tables of
 *                  source/types/renderer/ipc-bridge.ts, the tables that type
 *                  the call of a window. A handler map of a command channel
 *                  has one handler for each command of the contract, and
 *                  each handler returns the response that the contract
 *                  declares for its command.
 *
 * END HEADER
 */

import type {
  IpcBareChannelContracts,
  IpcFixedChannelContracts,
  IpcInvokeContracts,
  IpcRequestOf,
  IpcResponseOf,
} from "@dts/renderer/ipc-bridge";
import { type IpcMainInvokeEvent, ipcMain } from "electron";

/**
 * What a handler may return for the response R. A function without a return
 * statement has the type `void` in TypeScript and gives `undefined` at run
 * time, so it answers a response that holds `undefined`.
 */
export type Answer<R> = undefined extends R ? R | void : R;

/** A channel whose message carries a command. */
export type InvokeChannel = keyof IpcInvokeContracts;

/** A command of a command channel. */
export type InvokeCommand<C extends InvokeChannel> = keyof IpcInvokeContracts[C] & string;

/** The message of one command: the command and the fields of its request. */
export type InvokeMessage<C extends InvokeChannel, K extends InvokeCommand<C>> = {
  command: K;
} & IpcRequestOf<IpcInvokeContracts[C][K]>;

/** The response that the contract declares for one command. */
export type InvokeResponse<C extends InvokeChannel, K extends InvokeCommand<C>> = IpcResponseOf<
  IpcInvokeContracts[C][K]
>;

/**
 * The handlers of a command channel: one for each command of its contract.
 * A map without a command of the contract, with a command that the contract
 * does not name, or with a handler whose answer is not the response of its
 * command does not compile.
 */
export type InvokeHandlers<C extends InvokeChannel> = {
  [K in InvokeCommand<C>]: (
    event: IpcMainInvokeEvent,
    message: InvokeMessage<C, K>,
  ) => Answer<InvokeResponse<C, K>> | Promise<Answer<InvokeResponse<C, K>>>;
};

/**
 * Gives a message to the handler of its command. The handler map is a mapped
 * type over the commands, so the handler of the command K takes the message
 * of K and gives the response of K without a cast (TypeScript #47109).
 */
function answer<C extends InvokeChannel, K extends InvokeCommand<C>>(
  channel: C,
  handlers: InvokeHandlers<C>,
  event: IpcMainInvokeEvent,
  message: InvokeMessage<C, K>,
): Answer<InvokeResponse<C, K>> | Promise<Answer<InvokeResponse<C, K>>> {
  if (typeof message !== "object" || message === null) {
    throw new Error(`The channel ${channel} received a message without a command.`);
  }
  const command: K = message.command;
  if (!Object.hasOwn(handlers, command)) {
    throw new Error(`The channel ${channel} has no command ${String(command)}.`);
  }
  return handlers[command](event, message);
}

/**
 * Registers the handlers of a command channel. A message whose command has
 * no handler is an error that names the channel and the command.
 */
export function handleInvokeChannel<C extends InvokeChannel>(
  channel: C,
  handlers: InvokeHandlers<C>,
): void {
  // Electron types the message of a window as `any`. The call of the window
  // is typed by the same table (IpcInvoke), so the message is one of the
  // channel; `answer` examines its command before a handler gets it.
  ipcMain.handle(channel, (event, message: InvokeMessage<C, InvokeCommand<C>>) =>
    answer(channel, handlers, event, message),
  );
}

/** A channel whose message has one shape and no command. */
export type FixedChannel = keyof IpcFixedChannelContracts;

/** The handler of a channel whose message has one shape. */
export type FixedChannelHandler<C extends FixedChannel> = (
  event: IpcMainInvokeEvent,
  message: IpcFixedChannelContracts[C]["request"],
) =>
  | Answer<IpcFixedChannelContracts[C]["response"]>
  | Promise<Answer<IpcFixedChannelContracts[C]["response"]>>;

/** Registers the handler of a channel whose message has one shape. */
export function handleFixedChannel<C extends FixedChannel>(
  channel: C,
  handler: FixedChannelHandler<C>,
): void {
  // Electron types the message as `any`; the call of the window is typed by
  // IpcFixedChannelContracts.
  ipcMain.handle(channel, (event, message: IpcFixedChannelContracts[C]["request"]) =>
    handler(event, message),
  );
}

/** A channel that a window invokes without a message. */
export type BareChannel = keyof IpcBareChannelContracts;

/** The handler of a channel without a message. */
export type BareChannelHandler<C extends BareChannel> = (
  event: IpcMainInvokeEvent,
) => Answer<IpcBareChannelContracts[C]> | Promise<Answer<IpcBareChannelContracts[C]>>;

/** Registers the handler of a channel without a message. */
export function handleBareChannel<C extends BareChannel>(
  channel: C,
  handler: BareChannelHandler<C>,
): void {
  ipcMain.handle(channel, (event) => handler(event));
}

/**
 * Registers the handler of a channel without a message for one invoke; the
 * handler goes away after it answered.
 */
export function handleBareChannelOnce<C extends BareChannel>(
  channel: C,
  handler: BareChannelHandler<C>,
): void {
  ipcMain.handleOnce(channel, (event) => handler(event));
}

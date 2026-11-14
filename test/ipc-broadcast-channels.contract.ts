/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Broadcast-channel IPC contract fixtures
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Compile-time fixtures for the channels on which the main
 *                  process sends a window a message: the listener of
 *                  window.ipc.on and the senders broadcastIPCMessage,
 *                  sendIPCMessage, replyIPCMessage and tellMainWindows,
 *                  checked by the typecheck (test/ is in the tsconfig
 *                  include), as ipc-invoke-channels.contract.ts does for
 *                  invoke. A @ts-expect-error that stops being an error is a
 *                  compile failure. Each payload type comes from
 *                  IpcBroadcastContracts, which imports it from its sender
 *                  (#57).
 *
 * END HEADER
 */

import type { Stats } from "source/app/service-providers/stats";
import type { TagRecord } from "source/app/service-providers/tags";
import type tellMainWindows from "source/app/service-providers/windows/tell-main-windows";
import type broadcastIPCMessage from "source/common/util/broadcast-ipc-message";
import type {
  IpcMessageTarget,
  replyIPCMessage,
  sendIPCMessage,
} from "source/common/util/broadcast-ipc-message";

declare const on: ZettlrIpcOn;
declare const broadcast: typeof broadcastIPCMessage;
declare const send: typeof sendIPCMessage;
declare const reply: typeof replyIPCMessage;
declare const tell: typeof tellMainWindows;
declare const target: IpcMessageTarget;
declare const event: Parameters<typeof replyIPCMessage>[0];
declare const stats: Stats;

/** A listener gets the payload that the table declares, with no annotation. */
export function listensForStatistics(): void {
  on("stats-updated", (_event, received) => {
    const words: Record<string, number> = received.wordCount;
    return void words;
  });
}

/** The command of a channel with two shapes selects the payload. */
export function listensForTags(): void {
  on("tag-provider", (_event, ...message) => {
    if (message[0] === "tags-updated") {
      const tags: TagRecord[] = message[1];
      return void tags;
    }
  });
}

export function listensOnAnUnknownChannel(): void {
  // @ts-expect-error The table declares no channel of this name.
  on("stats-changed", () => {});
}

export function annotatesAnotherPayload(): void {
  // @ts-expect-error stats-updated carries the statistics, not a string.
  on("stats-updated", (_event, received: string) => {
    return void received;
  });
}

export function listensForAShortcutThatNoMenuSends(): void {
  on("shortcut", (_event, shortcut) => {
    // @ts-expect-error No sender sends this name on the shortcut channel.
    return void (shortcut === "insert-everything");
  });
}

export function broadcastsTheStatistics(): void {
  broadcast("stats-updated", stats);
}

export function broadcastsAnotherPayload(): void {
  // @ts-expect-error stats-updated carries the statistics, not their word count.
  broadcast("stats-updated", stats.wordCount);
}

export function broadcastsOnAnUnknownChannel(): void {
  // @ts-expect-error The table declares no channel of this name.
  broadcast("stats-changed", stats);
}

export function sendsATableWithoutItsSize(): void {
  // @ts-expect-error insert-table carries the size of the table.
  send(target, "insert-table");
}

export function sendsAShortcutWithAPayload(): void {
  // @ts-expect-error A shortcut is its name only.
  send(target, "shortcut", "save-file", { rows: 2, cols: 2 });
}

export function repliesWithAnotherCommand(): void {
  // @ts-expect-error window-controls has no command of this name.
  reply(event, "window-controls", { command: "maximise", payload: true });
}

export function tellsAWindowAnotherPayload(): void {
  // @ts-expect-error command-failed carries a failure, not a message string.
  tell([], undefined, "command-failed", "The command failed.");
}

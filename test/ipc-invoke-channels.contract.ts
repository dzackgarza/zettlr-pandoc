/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Multiplexer-channel IPC contract fixtures
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Compile-time fixtures for the command channels of
 *                  window.ipc.invoke and for CommandProvider.run, checked by
 *                  the typecheck (test/ is in the tsconfig include), as
 *                  ipc-operation-channels.contract.ts does for the document
 *                  operation channels. A @ts-expect-error that stops being an
 *                  error is a compile failure. Each type comes from the
 *                  contract map beside its handler (#57).
 *
 * END HEADER
 */

import type CommandProvider from "source/app/service-providers/commands";
import type { ApplicationPayload } from "source/app/service-providers/commands";

declare const invoke: ZettlrIpcInvoke;
declare const commands: CommandProvider;

/** A duplicate names the window that opens the copy by its key. */
export async function duplicatesIntoAWindow(): Promise<undefined> {
  return await invoke("application", {
    command: "file-duplicate",
    payload: { path: "/notes/a.md", windowId: "main-1" },
  });
}

export const duplicateWithTheOldField: ApplicationPayload<"file-duplicate"> = {
  path: "/notes/a.md",
  windowId: "main-1",
  // @ts-expect-error The window is named by windowId; windowNumber is no field.
  windowNumber: 1,
};

export async function rendersSyncCitationOverInvoke(): Promise<void> {
  // @ts-expect-error get-citation-sync is sent synchronously; invoke has no such command.
  await invoke("citeproc-provider", {
    command: "get-citation-sync",
    payload: { database: "main", citations: [], composite: false },
  });
}

export async function abortsATaskOverInvoke(): Promise<void> {
  // @ts-expect-error abort-task is sent; invoke has no such command.
  await invoke("lrt-provider", {
    command: "abort-task",
    payload: { id: "task-1" },
  });
}

export async function createsAFileWithoutAPayload(): Promise<void> {
  // @ts-expect-error file-new requires its payload object.
  await invoke("application", { command: "file-new" });
}

export async function createsADirectoryWithoutAPayload(): Promise<void> {
  // @ts-expect-error dir-new requires its payload.
  await invoke("application", { command: "dir-new" });
}

// @ts-expect-error dir-new requires the folder that holds the new directory.
export const directoryWithoutItsParent: ApplicationPayload<"dir-new"> = { name: "drafts" };

export async function runsFileNewWithoutAPayloadInMain(): Promise<void> {
  // @ts-expect-error The main-process run checks the payload against the contract too.
  await commands.run("file-new", undefined);
}

export async function runsACommandOutsideTheContract(): Promise<void> {
  // @ts-expect-error A command that the contract does not name cannot run.
  await commands.run("file-new-everywhere", {});
}

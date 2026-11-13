/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        followChildren
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Tells the items of the file manager when a batch of
 *                  filesystem events changes the list of their children.
 *                  The window has one listener on fsal-events for all items.
 *
 * END HEADER
 */

import { pathDirname } from "@common/util/renderer-path-polyfill";
import type { FSALEventPayload } from "source/app/service-providers/fsal";

const ipcRenderer = window.ipc;

/** The callbacks of the items that follow the children of each directory. */
const followers = new Map<string, Set<() => void>>();
let stopListening: (() => void) | undefined;

/**
 * Calls the followers of each directory whose direct children the batch adds,
 * changes or removes, one time for the batch. An event for a directory itself
 * belongs to the item of its parent.
 */
function dispatch(events: FSALEventPayload[]): void {
  const parents = new Set<string>();
  for (const payload of events) {
    parents.add(pathDirname("path" in payload ? payload.path : payload.descriptor.path));
  }
  for (const parent of parents) {
    // A directory that no item shows has no followers.
    const onChanges = followers.get(parent);
    if (onChanges === undefined) {
      continue;
    }
    for (const onChange of onChanges) {
      onChange();
    }
  }
}

/**
 * Follows the children of one directory. The cost of a batch follows the
 * number of its events, not the number of rows of the file manager.
 *
 * @param   {string}      directoryPath  The path of the item
 * @param   {() => void}  onChange       Called once for each batch that
 *                                       changes a direct child
 *
 * @return  {() => void}                 Ends the subscription
 */
export function followChildren(directoryPath: string, onChange: () => void): () => void {
  if (stopListening === undefined) {
    stopListening = ipcRenderer.on("fsal-events", (_, events: FSALEventPayload[]) => {
      dispatch(events);
    });
  }
  const callbacks = followers.get(directoryPath) ?? new Set<() => void>();
  callbacks.add(onChange);
  followers.set(directoryPath, callbacks);

  return () => {
    callbacks.delete(onChange);
    if (callbacks.size === 0) {
      followers.delete(directoryPath);
    }
    if (followers.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
}

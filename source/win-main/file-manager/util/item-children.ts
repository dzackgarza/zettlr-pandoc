/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useItemChildren
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The children of the item that a row of the file manager
 *                  shows. A row can get the item of another path: the file
 *                  list keeps its rows while the folder that it shows
 *                  changes. The children are those of the item that the row
 *                  shows now, and a row of a file has none and asks the
 *                  filesystem for none.
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import type { AnyDescriptor } from "@dts/common/fsal";
import { onUnmounted, ref, watch } from "vue";
import { followChildren } from "./follow-children";

const ipcRenderer = window.ipc;

/**
 * Gives the children of the item of a row and keeps them current.
 *
 * @param   {() => AnyDescriptor}  item  The item that the row shows now
 */
export function useItemChildren(item: () => AnyDescriptor) {
  const children = ref<AnyDescriptor[]>([]);
  let stopFollowing: (() => void) | undefined;
  let lastRead = 0;

  async function read(directoryPath: string): Promise<void> {
    lastRead += 1;
    const thisRead = lastRead;
    const listed = await ipcRenderer.invoke("fsal", {
      command: "read-directory",
      payload: directoryPath,
    });
    // The answer is for the row only while no later read started; a row
    // that got another item started one or shows a file.
    if (thisRead === lastRead) {
      children.value = listed;
    }
  }

  watch(
    () => {
      const shown = item();
      return shown.type === "directory" ? shown.path : undefined;
    },
    (directoryPath) => {
      stopFollowing?.();
      stopFollowing = undefined;
      lastRead += 1;
      children.value = [];
      if (directoryPath === undefined) {
        return;
      }
      const readAgain = (): void => {
        read(directoryPath).catch((err) =>
          reportError(`[File manager] Could not read the children of "${directoryPath}"`, err),
        );
      };
      // The row follows the events before its first read, so a read that
      // fails leaves a row that a later event of its children still updates.
      stopFollowing = followChildren(directoryPath, readAgain);
      readAgain();
    },
    { immediate: true },
  );

  onUnmounted(() => {
    stopFollowing?.();
  });

  return children;
}

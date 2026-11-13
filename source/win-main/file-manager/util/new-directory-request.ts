/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        newDirectoryRequest
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The folder in which the menu item "New directory…" asks
 *                  for a new folder. The file manager holds the one shortcut
 *                  listener of the window and sets the request; the row of
 *                  that folder opens its name field.
 *
 * END HEADER
 */

import { ref } from "vue";

/**
 * The path of the folder of the request while the request goes out, else
 * undefined. A row reads it with a synchronous watcher.
 */
export const newDirectoryRequest = ref<string | undefined>(undefined);

/**
 * Asks the row of a folder to open its name field for a new folder.
 *
 * @param  {string}  directoryPath  The folder that gets the new folder
 */
export function requestNewDirectory(directoryPath: string): void {
  newDirectoryRequest.value = directoryPath;
  newDirectoryRequest.value = undefined;
}

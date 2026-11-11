/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        openPath
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens a file or a folder with the application that the
 *                  desktop has for it.
 *
 * END HEADER
 */

import { shell } from "electron";
import { AuthoredFileError } from "./authored-file-error";

/**
 * Opens a path with the application of the desktop. Electron resolves
 * `shell.openPath` with the words of the refusal, and with an empty string
 * for a path that opened
 * (https://www.electronjs.org/docs/latest/api/shell#shellopenpathpath). A
 * refusal rejects here, so a caller cannot take it for a success.
 */
export async function openPath(target: string): Promise<void> {
  const refusal = await shell.openPath(target);
  if (refusal !== "") {
    throw new AuthoredFileError("open", target, refusal);
  }
}

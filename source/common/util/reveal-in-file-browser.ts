/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        revealInFileBrowser
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Reveal in File Browser" of each surface: a file row, a
 *                  folder row, a tab and a file link (#202).
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";

const ipcRenderer = window.ipc;

/**
 * Show a folder, or the folder of a file, in the file browser of the
 * desktop. The dispatcher shows a refusal in this window (`command-failed`).
 *
 * @param  target  The path of the file or folder, or the URI of a file link
 */
export function revealInFileBrowser(target: { path: string } | { uri: string }): void {
  ipcRenderer
    .invoke("application", { command: "reveal-path", payload: target })
    .catch((err) => reportError(err));
}

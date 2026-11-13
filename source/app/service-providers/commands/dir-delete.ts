/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DirDelete command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command deletes a directory.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type DocumentManager from "@providers/documents";
import type FSAL from "@providers/fsal";
import { dialog, type MessageBoxOptions } from "electron";
import path from "path";
import ZettlrCommand from "./zettlr-command";

/** The services that the command uses. */
export interface DirDeleteServices {
  documents: Pick<DocumentManager, "closeDocumentsForDelete" | "setAsideStateOfDeleted">;
  fsal: Pick<FSAL, "removeDir">;
}

export default class DirDelete extends ZettlrCommand<DirDeleteServices> {
  constructor(app: DirDeleteServices) {
    super(app, "dir-delete");
  }

  /**
   * Remove a directory.
   * @param {String} evt The event name
   * @param  {Object} arg An object containing hash of containing and name of new dir.
   */
  async run(evt: string, arg: { path: string }): Promise<boolean> {
    const dirName = path.basename(arg.path);
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: [trans("Ok"), trans("Cancel")],
      defaultId: 0,
      cancelId: 1,
      title: trans("Really delete?"),
      message: trans("Do you really want to remove %s?", dirName),
    };

    const response = await dialog.showMessageBox(options);
    if (response.response !== 0) {
      return false;
    }

    // The documents of the folder are closed before it is removed. A
    // refused close keeps the folder: the buffer and the review of that
    // document are in the open document.
    if (!(await this._app.documents.closeDocumentsForDelete(arg.path))) {
      throw new Error(trans("%s was not deleted: an open document could not be closed.", dirName));
    }

    await this._app.fsal.removeDir(arg.path);
    // The review state of each deleted document goes aside: a new file at
    // its path does not get it.
    await this._app.documents.setAsideStateOfDeleted(arg.path);
    return true;
  }
}

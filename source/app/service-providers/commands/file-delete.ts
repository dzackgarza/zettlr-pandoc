/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FileDelete command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command deletes a file.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type DocumentManager from "@providers/documents";
import type FSAL from "@providers/fsal";
import type LogProvider from "@providers/log";
import { dialog, type MessageBoxOptions } from "electron";
import path from "path";
import ZettlrCommand from "./zettlr-command";

/** The services that the command uses. */
export interface FileDeleteServices {
  log: Pick<LogProvider, "info">;
  documents: Pick<DocumentManager, "closeDocumentsForDelete" | "setAsideStateOfDeleted">;
  fsal: Pick<FSAL, "removeFile">;
}

export default class FileDelete extends ZettlrCommand<FileDeleteServices> {
  constructor(app: FileDeleteServices) {
    super(app);
  }

  /**
   * Removes a file.
   * @param {String} evt The event name
   * @param  {Object} arg the parameters of the file to be deleted
   * @return {Boolean} Whether the file was successfully deleted.
   */
  async run(evt: string, arg: { path: string }): Promise<boolean> {
    const fileName = path.basename(arg.path);
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: [trans("Ok"), trans("Cancel")],
      defaultId: 0,
      cancelId: 1,
      title: trans("Really delete?"),
      message: trans("Do you really want to remove %s?", fileName),
    };

    const response = await dialog.showMessageBox(options);
    if (response.response !== 0) {
      return false;
    }

    // The file is closed before it is removed. A refused close keeps the
    // file: its buffer and its review are in the open document.
    if (!(await this._app.documents.closeDocumentsForDelete(arg.path))) {
      throw new Error(
        trans("%s was not deleted: the open document could not be closed.", fileName),
      );
    }

    await this._app.fsal.removeFile(arg.path);
    // The review state of the deleted document goes aside: a new file at
    // the path does not get it.
    await this._app.documents.setAsideStateOfDeleted(arg.path);

    this._app.log.info(`Removed file ${fileName}.`);
    return true;
  }
}

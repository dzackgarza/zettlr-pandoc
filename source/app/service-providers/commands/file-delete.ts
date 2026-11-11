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
import { dialog, type MessageBoxOptions } from "electron";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class FileDelete extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "file-delete");
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
    if (!(await this._app.documents.closeFileEverywhere(arg.path))) {
      throw new Error(
        trans("%s was not deleted: the open document could not be closed.", fileName),
      );
    }

    // Now, remove the file
    await this._app.fsal.removeFile(arg.path);

    this._app.log.info(`Removed file ${fileName}.`);
    return true;
  }
}

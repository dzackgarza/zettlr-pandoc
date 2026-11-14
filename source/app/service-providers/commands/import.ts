/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ImportFiles command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command imports files into the app.
 *
 * END HEADER
 */

import { import_files as FORMATS } from "@common/data.json";
import { trans } from "@common/i18n-main";
import { showNativeNotification } from "@common/util/show-notification";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import makeImport from "./importer";
import ZettlrCommand from "./zettlr-command";

export default class ImportFiles extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app);
  }

  /**
   * Asks the author for a folder and for files, and imports the files into
   * the folder. The command throws when a file was not imported: the message
   * names each such file with the cause.
   *
   * @return  {Promise<boolean>}  False when the author chose no folder or no file
   */
  async run(_event: string, _arg: void): Promise<boolean> {
    const dirs = await this._app.windows.askDir(
      trans("Import directory"),
      undefined,
      trans("Select folder"),
      trans("Select import destination"),
    );
    if (dirs.length === 0) {
      return false;
    }

    // Prepare the list of file filters
    // The "All Files" filter should be at the top
    const fltr = [{ name: trans("All Files"), extensions: ["*"] }];
    for (const f of FORMATS) {
      // The import_files array has the structure "readable format" "extensions"...
      // Here we set index 1 as readable name and all following elements (without leading dots)
      // as extensions
      fltr.push({ name: f[0], extensions: f.slice(1) });
    }

    const fileList = await this._app.windows.askFile(fltr, true);
    if (fileList.length === 0) {
      return false;
    }

    showNativeNotification(trans("Importing. Please wait …"));

    const directory = await this._app.fsal.getAnyDirectoryDescriptor(dirs[0]);
    this._app.log.info(`[Importer] Importing ${fileList.length} files: ${fileList.join(", ")} ...`);
    const outcomes = await makeImport(fileList, directory, this._app.assets);

    const refusals: string[] = [];
    for (const outcome of outcomes) {
      const name = path.basename(outcome.source);
      if (outcome.result === "imported") {
        this._app.log.info(`[Importer] File ${outcome.source} imported successfully.`);
        showNativeNotification(trans("%s imported successfully.", name));
      } else {
        refusals.push(trans("Could not import %s: %s.", name, outcome.cause));
      }
    }

    if (refusals.length > 0) {
      throw new Error(refusals.join(" "));
    }

    return true;
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RenameTag command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command renames a tag across all files.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import replaceTags from "@common/util/replace-tags";
import type { MDFileDescriptor } from "@dts/common/fsal";
import { dialog } from "electron";
import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class RenameTag extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "rename-tag");
  }

  /**
   * Replace a tag in each file that has it.
   * @param {String} evt The event name
   * @param  {Object} arg The old and the new name of the tag.
   */
  async run(evt: string, arg: { oldName: string; newName: string }): Promise<boolean> {
    const oldName: string = arg.oldName;
    const newName: string = arg.newName.trim();
    if (newName === "") {
      throw new Error(trans('The tag "%s" needs a new name.', oldName));
    }

    // First, retrieve all files from the FSAL
    const allFiles = (await this._app.fsal.getAllLoadedDescriptors()).filter(
      (d) => d.type === "file",
    ) as MDFileDescriptor[];

    // Then, retain only the relevant files
    const relevantFiles = allFiles.filter((d: MDFileDescriptor) => d.tags.includes(oldName));

    const response = await dialog.showMessageBox({
      title: trans("Confirm"),
      message: trans(
        'Replace tag "%s" with "%s" across %s files?',
        oldName,
        newName,
        relevantFiles.length,
      ),
      buttons: [trans("Yes"), trans("Cancel")],
      defaultId: 1,
    });

    if (response.response === 1) {
      return false; // Do not replace the tag.
    }

    // Lastly, do the replacing file by file. NOTE: This rests on the fact that
    // the FSAL will pick up those changes via the file system itself. One file
    // that cannot be changed does not stop the others; the command names each.
    const refusals: string[] = [];
    for (const file of relevantFiles) {
      const refusal = await this.renameIn(file.path, oldName, newName).then(
        () => undefined,
        (err: Error) => `${file.path}: ${err.message}`,
      );
      if (refusal !== undefined) {
        refusals.push(refusal);
      }
    }

    if (refusals.length > 0) {
      throw new Error(
        trans(
          'The tag "%s" was not replaced in %s of %s files:\n%s',
          oldName,
          refusals.length,
          relevantFiles.length,
          refusals.join("\n"),
        ),
      );
    }
    return true;
  }

  private async renameIn(filePath: string, oldName: string, newName: string): Promise<void> {
    const content = await this._app.fsal.readTextFile(filePath);
    const newContent = replaceTags(content, oldName, newName);
    if (newContent === content) {
      throw new Error(trans("The file does not contain the tag."));
    }
    await this._app.fsal.writeTextFile(filePath, newContent);
    this._app.log.info(
      `[Application] Replaced tag "${oldName}" with "${newName}" in file ${filePath}`,
    );
  }
}

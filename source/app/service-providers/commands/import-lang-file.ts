/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ImportLangFile command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command imports a new language file.
 *
 * END HEADER
 */

import { copyFile, mkdir } from "node:fs/promises";
import { trans } from "@common/i18n-main";
import { translationTag } from "@common/util/enum-lang-files";
import { showNativeNotification } from "@common/util/show-notification";
import { app } from "electron";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import { systemErrorCause } from "source/app/util/system-error-cause";
import ZettlrCommand from "./zettlr-command";

export default class ImportLangFile extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "import-lang-file");
  }

  /**
   * Copies the translations that the author chooses into the language folder
   * of the app. A translation is a PO file whose name is its language tag
   * (`fr-CA.po`). The other chosen files are imported, and the command then
   * throws one error that names each refused file with its cause.
   *
   * @param   {string}  event  The event name
   *
   * @return  {Promise<boolean>}  True when no chosen file was refused
   */
  async run(event: string, _arg: void): Promise<boolean> {
    const files = await this._app.windows.askFile(
      [{ name: trans("Translation"), extensions: ["po"] }],
      true,
    );
    const langDir = path.join(app.getPath("userData"), "lang");
    const refusals: string[] = [];
    const imported: string[] = [];

    for (const file of files) {
      const name = path.basename(file);
      if (translationTag(name) === undefined) {
        refusals.push(
          trans(
            "Could not import the language file %s: %s.",
            file,
            trans("a translation is a PO file whose name is its language tag, such as fr-CA.po"),
          ),
        );
        continue;
      }
      const cause = await mkdir(langDir, { recursive: true })
        .then(() => copyFile(file, path.join(langDir, name)))
        .then(
          () => undefined,
          (err: NodeJS.ErrnoException) => systemErrorCause(err),
        );
      if (cause !== undefined) {
        refusals.push(
          trans(
            "Could not import the language file %s: %s.",
            file,
            trans("the folder %s refused it: %s", langDir, cause),
          ),
        );
        continue;
      }
      imported.push(name);
    }

    if (imported.length > 0) {
      showNativeNotification(trans("Language file imported: %s", imported.join(", ")));
    }
    if (refusals.length > 0) {
      throw new Error(refusals.join("\n"));
    }
    return true;
  }
}

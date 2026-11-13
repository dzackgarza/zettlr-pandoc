/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        UpdateProjectProperties command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command updates one or more project properties.
 *
 * END HEADER
 */

import path from "node:path";
import { trans } from "@common/i18n-main";
import type { ProjectSettings } from "@dts/common/fsal";
import type { AppServiceContainer } from "source/app/app-service-container";
import { systemErrorCause } from "source/app/util/system-error-cause";
import ZettlrCommand from "./zettlr-command";

export default class UpdateProjectProperties extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "update-project-properties");
  }

  /**
   * Display the project settings
   * @param {String} evt The event name
   * @param  {Object} arg The hash of a directory.
   */
  async run(evt: string, arg: { path: string; properties: ProjectSettings }): Promise<void> {
    // The properties come from the renderer with dot notation, but the action
    // expects them already in their expanded state.
    // let expanded = expandOptionObject(arg.properties)
    // Find the directory, and apply the properties to it!
    const name = path.basename(arg.path);
    const dir = await this._app.fsal.getAnyDirectoryDescriptor(arg.path);
    if (dir === undefined) {
      throw new Error(
        trans(
          "Could not save the Project settings of %s: %s.",
          name,
          trans("the folder is not open"),
        ),
      );
    }
    if (dir.settings.project?.manifest.kind === "quarto") {
      throw new Error(
        `Edit the Quarto book file ${dir.settings.project.manifest.path} to change settings for ${arg.path}`,
      );
    }
    await this._app.fsal.updateProject(dir, arg.properties).catch((failure: Error) => {
      throw new Error(
        trans("Could not save the Project settings of %s: %s.", name, systemErrorCause(failure)),
        { cause: failure },
      );
    });
  }
}

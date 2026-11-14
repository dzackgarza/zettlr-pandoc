/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DirRemoveProject command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command deletes a project.
 *
 * END HEADER
 */

import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class DirRemoveProject extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app);
  }

  /**
   * Remove the project of a directory
   *
   * @param  {string} evt  The event name
   * @param  {any}    arg  The payload
   */
  async run(evt: string, arg: { path: string }): Promise<void> {
    const dir = await this._app.fsal.getAnyDirectoryDescriptor(arg.path);
    if (dir === undefined) {
      throw new Error(`Could not remove the project: ${arg.path} is not a loaded directory.`);
    }
    await this._app.fsal.removeProject(dir);
  }
}

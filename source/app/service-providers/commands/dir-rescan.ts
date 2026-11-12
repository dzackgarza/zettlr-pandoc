/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DirRescan command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Loads a workspace whose folder was missing.
 *
 * END HEADER
 */

import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class DirRescan extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "rescan-dir");
  }

  /**
   * Loads the workspace at `arg.path` when its folder is there again.
   *
   * @throws when the folder is still missing
   */
  async run(_event: string, arg: { path: string }): Promise<void> {
    await this._app.fsal.loadMissingWorkspace(arg.path);
  }
}

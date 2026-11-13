/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RootClose command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command closes root files and directories.
 *
 * END HEADER
 */

import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class RootClose extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "root-close");
  }

  /**
   * Closes (not removes) root directories and root files, with each document
   * at or inside them, in one close. Resolves false and keeps each root when
   * a document stays open (DocumentManager.closeDocumentsInside).
   *
   * @param   {string}    evt    The event name
   * @param   {string[]}  roots  The paths of the roots
   */
  async run(evt: string, roots: string[]): Promise<boolean> {
    const closed = await this._app.documents.closeDocumentsInside(roots, async () => {
      await this.run(evt, roots);
    });
    if (!closed) {
      return false;
    }
    for (const root of roots) {
      this._app.config.removePath(root);
    }
    return true;
  }
}

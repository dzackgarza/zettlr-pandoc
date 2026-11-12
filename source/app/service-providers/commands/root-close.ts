/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RootClose command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command closes a root file or directory.
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
   * Closes (not removes) a root directory or a root file, with each document
   * at or inside it. Resolves false and keeps the root when a document stays
   * open (DocumentManager.closeDocumentsInside).
   *
   * @param   {string}  evt   The event name
   * @param   {string}  arg   The path of the root
   */
  async run(evt: string, arg: string): Promise<boolean> {
    const closed = await this._app.documents.closeDocumentsInside(arg, async () => {
      await this.run(evt, arg);
    });
    if (!closed) {
      return false;
    }
    this._app.config.removePath(arg);
    return true;
  }
}

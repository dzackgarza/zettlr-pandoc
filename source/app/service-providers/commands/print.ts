/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Print command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command shows the print window.
 *
 * END HEADER
 */

import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class Print extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app);
  }

  /**
   * Prints the current file (in: opening the print window)
   *
   * @param  {string}  evt The event name
   * @param  {any}     arg The argument
   */
  async run(evt: string, arg?: string): Promise<void> {
    const filePath = arg;

    if (filePath == null) {
      throw new Error("Cannot print: no document was given.");
    }

    // A loaded document has its text without its file (§14).
    if (this._app.documents.isDocumentOpen(filePath)) {
      this._app.windows.showPrintWindow(filePath);
      return;
    }

    const fileDescriptor = await this._app.fsal.getDescriptorForAnySupportedFile(filePath);

    if (fileDescriptor === undefined) {
      throw new Error(`Cannot print ${filePath}: the file was not found.`);
    }

    this._app.windows.showPrintWindow(fileDescriptor.path);
  }
}

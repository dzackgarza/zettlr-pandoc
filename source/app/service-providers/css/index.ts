/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CSSProvider
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Makes the custom CSS available throughout the app.
 *
 * END HEADER
 */

import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import { hasErrnoCode } from "@common/util/is-errno-exception";
import type LogProvider from "@providers/log";
import { app, ipcMain } from "electron";
import EventEmitter from "events";
import { promises as fs } from "fs";
import path from "path";
import { refusedAs } from "../../util/authored-file-error";
import { writeTextFile } from "../fsal/util/write-text-file";
import ProviderContract from "../provider-contract";

export default class CssProvider extends ProviderContract {
  private readonly _filePath: string;
  private readonly _emitter: EventEmitter;

  constructor(private readonly _logger: LogProvider) {
    super();
    this._filePath = path.join(app.getPath("userData"), "custom.css");

    this._emitter = new EventEmitter();

    ipcMain.handle("css-provider", async (event, payload) => {
      const { command } = payload;
      if (command === "get-custom-css-path") {
        return this._filePath;
      } else if (command === "get-custom-css") {
        return await this.get();
      } else if (command === "set-custom-css") {
        const css: string = payload.css;
        return await this.set(css);
      }
    });
  }

  async boot(): Promise<void> {
    this._logger.verbose("CSS provider booting up ...");

    // Check for the existence of the custom CSS file. If it is not existent,
    // create an empty one.
    try {
      await fs.lstat(this._filePath);
    } catch (err) {
      if (!hasErrnoCode(err, "ENOENT")) {
        throw err;
      }
      // Create an empty file with a nice initial comment in it.
      await fs.writeFile(this._filePath, "/* Enter your custom CSS here */\n\n", {
        encoding: "utf8",
      });
    }
  }

  /**
   * Shuts down the provider
   * @return {boolean} Whether or not the shutdown was successful
   */
  async shutdown(): Promise<void> {
    this._logger.verbose("CSS provider shutting down ...");
  }

  /**
   * Retrieves the content of the custom CSS file. Rejects with an
   * `AuthoredFileError` when the file system refuses the read.
   * @return {string} The custom CSS
   */
  async get(): Promise<string> {
    return await fs
      .readFile(this._filePath, { encoding: "utf8" })
      .catch(refusedAs("read", this._filePath));
  }

  /**
   * The renderer will need this path to dynamically load it in.
   * @return {string} The fully qualified path to the CSS file.
   */
  getPath(): string {
    return this._filePath;
  }

  /**
   * Writes new data to the custom CSS file and tells the windows. Rejects
   * with an `AuthoredFileError` when the file system refuses the write.
   * @param {string} newContent The new contents
   */
  async set(newContent: string): Promise<void> {
    await writeTextFile(this._filePath, newContent).catch(refusedAs("save", this._filePath));
    this._emitter.emit("update", this._filePath);
    broadcastIpcMessage("css-provider", {
      command: "get-custom-css-path",
      payload: this._filePath,
    });
    broadcastIpcMessage("css-provider", { command: "custom-css-updated" });
  }
}

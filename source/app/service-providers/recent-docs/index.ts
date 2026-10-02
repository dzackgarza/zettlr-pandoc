/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RecentDocsProvider class
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Manages the lists of recently opened and recently edited
 *                  documents. Both lists are newest first, hold one entry
 *                  per file and at most the configured number of files, and
 *                  persist in userData/recent-files.json across restarts.
 *
 * END HEADER
 */

import { app } from "electron";
import EventEmitter from "events";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";
import type { ConfigOptions } from "../config/get-config-template";
import type LogProvider from "../log";
import ProviderContract from "../provider-contract";

const recentFilesSchema = z.object({
  opened: z.array(z.string()),
  edited: z.array(z.string()),
});

/** The recently opened and recently edited files, each newest first. */
export type RecentFiles = z.infer<typeof recentFilesSchema>;

/** The one setting the lists read: how many files each keeps. */
interface RecentFilesConfig {
  get: () => { ui: Pick<ConfigOptions["ui"], "recentFilesLimit"> };
}

/**
 * Keeps the recently opened and recently edited files, each newest first.
 */
export default class RecentDocumentsProvider extends ProviderContract {
  private _files: RecentFiles;
  private readonly _storePath: string;
  private _pendingWrite: Promise<void>;
  private readonly _emitter: EventEmitter;

  constructor(
    private readonly _logger: LogProvider,
    private readonly _config: RecentFilesConfig,
  ) {
    super();
    this._files = { opened: [], edited: [] };
    this._storePath = path.join(app.getPath("userData"), "recent-files.json");
    this._pendingWrite = Promise.resolve();
    this._emitter = new EventEmitter();
  }

  /** Reads the persisted lists; a malformed store is an error, not an empty list. */
  async boot(): Promise<void> {
    if (!existsSync(this._storePath)) {
      return;
    }
    this._files = recentFilesSchema.parse(JSON.parse(await readFile(this._storePath, "utf-8")));
  }

  on(evt: string, callback: (...args: any[]) => void): void {
    this._emitter.on(evt, callback);
  }

  off(evt: string, callback: (...args: any[]) => void): void {
    this._emitter.off(evt, callback);
  }

  /**
   * Add a document to the list of recently opened documents
   * @param {string} docPath The absolute path of the file
   */
  add(docPath: string): void {
    this._files.opened = this._newestFirst(this._files.opened, docPath);
    // Push the file into the doc-menu if we're on macOS or Windows
    if (["darwin", "win32"].includes(process.platform)) {
      app.addRecentDocument(docPath);
    }
    this._persist();
  }

  /** Puts a document a save just wrote at the top of the recently edited list. */
  markEdited(docPath: string): void {
    this._files.edited = this._newestFirst(this._files.edited, docPath);
    this._persist();
  }

  /**
   * Clears out the list of recent files
   */
  clear(): void {
    this._files = { opened: [], edited: [] };
    // Clear the application's recent docs menu as well on macOS or Windows
    if (["darwin", "win32"].includes(process.platform)) {
      app.clearRecentDocuments();
    }
    this._persist();
  }

  /**
   * Retrieve the list of recently opened documents, newest first.
   * @return {Array} A list containing all documents in the recent list
   */
  get(): string[] {
    this._files.opened = this._existing(this._files.opened);
    return [...this._files.opened];
  }

  /** The recently edited documents, newest first. */
  getEdited(): string[] {
    this._files.edited = this._existing(this._files.edited);
    return [...this._files.edited];
  }

  /** The list with the path first and once, cut to the configured length. */
  private _newestFirst(list: string[], docPath: string): string[] {
    const limit = this._config.get().ui.recentFilesLimit;
    return [docPath, ...list.filter((item) => item !== docPath)].slice(0, limit);
  }

  /** The list without the files that are no longer on disk; a removal is written. */
  private _existing(list: string[]): string[] {
    const existing = list.filter((item) => existsSync(item));
    if (existing.length !== list.length) {
      this._write();
    }
    return existing;
  }

  /** Writes the store and announces the change. */
  private _persist(): void {
    this._write();
    this._emitter.emit("update");
  }

  /** Writes the store after the write before it. */
  private _write(): void {
    const snapshot = JSON.stringify(this._files, null, 2);
    this._pendingWrite = this._pendingWrite
      .then(async () => await writeFile(this._storePath, snapshot, "utf-8"))
      .catch((err: unknown) => {
        this._logger.error(`[RecentDocs] Could not write ${this._storePath}`, err);
      });
  }

  /**
   * Shuts down the provider
   * @return {Boolean} Always returns true
   */
  async shutdown(): Promise<void> {
    this._logger.verbose("Recent documents provider shutting down ...");
    await this._pendingWrite;
  }
}

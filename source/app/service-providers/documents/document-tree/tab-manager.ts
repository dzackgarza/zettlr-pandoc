/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TabManager
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The tab manager manages the open documents for a single
 *                  editor pane. Tab managers aren't instantiated standalone but
 *                  are meant to be contained within a document tree leaf.
 *
 * END HEADER
 */

import type { OpenDocument } from "@dts/common/documents";
import type { DocumentLocation } from "@dts/common/references";

export interface TabManagerJSON {
  openFiles: OpenDocument[];
  activeFile: OpenDocument | null;
}

/**
 * One widened per-pane session history entry (issue #1 Phase 5): the file
 * path plus, optionally, the exact DocumentLocation captured at the moment
 * the pane jumped away from that file. Entries created by the plain
 * openFile() flow carry no location (`location: undefined`) and keep
 * restoring by path exactly as before the widening. Session history remains
 * in-memory only: toJSON() still serializes only { openFiles, activeFile }.
 */
export interface HistoryEntry {
  path: string;
  location?: DocumentLocation;
}

export class TabManager {
  private readonly _openFiles: OpenDocument[];
  private _activeFile: OpenDocument | null;
  private readonly _sessionHistory: HistoryEntry[];
  private _sessionPointer: number;

  constructor() {
    this._openFiles = [];
    this._activeFile = null;
    this._sessionHistory = [];
    this._sessionPointer = -1;
  }

  // GETTERS AND SETTERS

  /**
   * Returns the list of currently opened files in this tab manager
   *
   * @return  {OpenDocument[]}  The currently open documents
   */
  public get openFiles(): OpenDocument[] {
    return this._openFiles;
  }

  /**
   * Sets the active file to the one given; can either be an OpenDocument or
   * a file path. Provide null to unset
   *
   * @param  {OpenDocument|string|null}  file  The new active file
   */
  public set activeFile(file: OpenDocument | string | null) {
    if (typeof file === "string") {
      const doc = this._openFiles.find((doc) => doc.path === file);
      if (doc === undefined) {
        return;
      }
      file = doc;
    }

    this._activeFile = file;
  }

  /**
   * Returns the current active file
   *
   * @return  {OpenDocument|null}  The active file or null
   */
  public get activeFile(): OpenDocument | null {
    return this._activeFile;
  }

  /**
   * The widened per-pane session history (issue #1 Phase 5): one
   * { path, location? } entry per session step, in order. Observability
   * surface for the documents provider; never mutate the returned entries.
   *
   * @return  {readonly HistoryEntry[]}  The session history entries
   */
  public get history(): readonly HistoryEntry[] {
    return this._sessionHistory;
  }

  /**
   * Whether a back() call would restore an older history entry.
   *
   * @return  {boolean}  True when history holds an entry before the pointer
   */
  public get canGoBack(): boolean {
    return this._normalizedSessionPointer() > 0;
  }

  /**
   * Whether a forward() call would restore a newer history entry.
   *
   * @return  {boolean}  True when history holds an entry after the pointer
   */
  public get canGoForward(): boolean {
    const pointer = this._normalizedSessionPointer();
    return pointer >= 0 && pointer < this._sessionHistory.length - 1;
  }

  // PUBLIC METHODS

  /**
   * Sorts the openFiles according to pathArray.
   *
   * @param  {string[]}  pathArray  An array with absolute paths to sort with
   *
   * @return {boolean}              The new sorting
   */
  public sortOpenFiles(pathArray: string[]): boolean {
    // Only sort if something changed
    if (pathArray.length === this._openFiles.length) {
      let somethingChanged = false;
      for (let i = 0; i < pathArray.length; i++) {
        if (this._openFiles[i].path !== pathArray[i]) {
          somethingChanged = true;
          break;
        }
      }

      if (!somethingChanged) {
        return false;
      }
    }

    // Simply re-sort based on the new paths
    this._openFiles.sort((a, b) => {
      return pathArray.indexOf(a.path) - pathArray.indexOf(b.path);
    });

    this.movePinnedTabsLeft();

    return true;
  }

  /**
   * This function (re)sorts the open files solely based on their pinned status
   */
  private movePinnedTabsLeft(): void {
    // Also make sure that pinned tabs are all grouped to the left before sync
    this._openFiles.sort((a, b) => {
      if (a.pinned && !b.pinned) {
        return -1;
      }
      if (!a.pinned && b.pinned) {
        return 1;
      }
      return 0;
    });
  }

  /**
   * Opens a file within this tab manager.
   *
   * @param   {string}   filePath       The absolute file path
   * @param   {boolean}  modifyHistory  Optional. Only used internally.
   *
   * @return  {Promise<boolean>}        True upon successful opening
   */
  public openFile(filePath: string, modifyHistory?: boolean): boolean {
    if (this.activeFile?.path === filePath) {
      return false;
    }
    const openFile = this._openFiles.find((file) => file.path === filePath);

    // Remove the file from the session history if applicable
    if (modifyHistory !== false) {
      const sessionIndex = this._sessionHistory.findIndex((entry) => entry.path === filePath);
      if (sessionIndex > -1) {
        this._sessionHistory.splice(sessionIndex, 1);
      }
    }

    // If the file is already open, we just set it as the active one and be done
    // with it, no further action needed
    if (openFile !== undefined) {
      if (modifyHistory !== false) {
        this._sessionHistory.push({ path: filePath });
        this._sessionPointer = this._sessionHistory.length - 1;
      }
      this.activeFile = openFile;
      return true;
    }

    const file: OpenDocument = { path: filePath, pinned: false };

    if (this._activeFile !== null) {
      // ... behind our active file
      const idx = this._openFiles.indexOf(this._activeFile);
      this._openFiles.splice(idx + 1, 0, file);
    } else {
      // ... or at the end
      this._openFiles.push(file);
    }

    // Update all required states. Especially make sure to re-sort this to
    // ensure the new file (unpinned) doesn't end up in between several pinned
    // files.
    this.sortOpenFiles(this._openFiles.map((d) => d.path));
    this.movePinnedTabsLeft();

    this.activeFile = file;

    if (modifyHistory !== false) {
      this._sessionHistory.push({ path: filePath });
      this._sessionPointer = this._sessionHistory.length - 1;
    }

    return true;
  }

  /**
   * Closes the given file if it's in fact open. This function deals with every
   * potential problem such as retrieving user consent to closing the file if it
   * is modified.
   *
   * @param   {MDFileDescriptor|CodeFileDescriptor}  file  The file to be closed
   *
   * @return  {boolean}                                    Whether or not the file was closed
   */
  public closeFile(file: OpenDocument | string): boolean {
    if (typeof file === "string") {
      const doc = this._openFiles.find((doc) => doc.path === file);
      if (doc !== undefined) {
        file = doc;
      } else {
        return false;
      }
    }
    if (!this._openFiles.includes(file)) {
      return false; // All good, we didn't even have to close the file.
    }

    if (file.pinned) {
      // TODO this._app.log.warning(`[Document Provider] Refusing to close pinned file ${file.path}`)
      return false;
    }

    // Retrieve the index of the active file and whether it's an active file
    const activeFileIdx =
      this._activeFile === null ? -1 : this._openFiles.indexOf(this._activeFile);
    const isActive = this._activeFile === file;

    // Then remove the file from the list of open files
    this._openFiles.splice(this._openFiles.indexOf(file), 1);

    // Now, if we just closed the active file, we need to make another file
    // active, or none, if there are no more open files active.
    if (!isActive) {
      return true;
    } else {
      this.activeFile = null;
    }

    if (this._openFiles.length > 0 && activeFileIdx > 0) {
      this.activeFile = this._openFiles[activeFileIdx - 1];
    } else if (this._openFiles.length > 0 && activeFileIdx === 0) {
      this.activeFile = this._openFiles[0];
    }

    return true;
  }

  /**
   * This function is a convenience when the path of a file has changed without
   * the file being deleted or otherwise removed from the app. NOTE that you
   * still have to emit any events to notify the editors of this change.
   *
   * @param   {string}  oldPath  The old path
   * @param   {string}  newPath  The new path
   *
   * @return  {boolean}          False if the file was not open here
   */
  public replaceFilePath(oldPath: string, newPath: string): boolean {
    const file = this.openFiles.find((doc) => doc.path === oldPath);
    if (file === undefined) {
      console.log(
        `Didnt find file for path ${oldPath} -- nothing has changed.`,
        this.openFiles.map((doc) => doc.path),
      );
      return false;
    }

    file.path = newPath;
    if (this.activeFile?.path === oldPath) {
      this.activeFile = file;
    }

    return true;
  }

  /**
   * Stamps the CURRENT session history entry with the location captured at
   * the moment the pane is about to jump away from it (issue #1 Phase 5), so
   * a later back()/forward() can restore the exact selection, viewport
   * scroll, and folds. A no-op while the history is empty.
   *
   * @param   {DocumentLocation}  location  The captured location
   */
  public updateCurrentHistoryLocation(location: DocumentLocation): void {
    const pointer = this._normalizedSessionPointer();
    if (pointer < 0) {
      return; // Empty history: nothing to stamp
    }

    this._sessionHistory[pointer].location = location;
  }

  /**
   * Goes back in the session history and opens the previous file
   *
   * @return  {HistoryEntry|null}  The restored { path, location } entry, or
   *                               null at the history boundary
   */
  public back(): HistoryEntry | null {
    return this._moveThroughHistory(-1);
  }

  /**
   * Goes forward in the session history and opens the next file
   *
   * @return  {HistoryEntry|null}  The restored { path, location } entry, or
   *                               null at the history boundary
   */
  public forward(): HistoryEntry | null {
    return this._moveThroughHistory(1);
  }

  /**
   * Returns the session pointer, normalized the same way _moveThroughHistory
   * always normalized it: an out-of-range pointer snaps to the newest entry
   * (which is -1 exactly when the history is empty).
   *
   * @return  {number}  The normalized pointer
   */
  private _normalizedSessionPointer(): number {
    if (this._sessionPointer < 0 || this._sessionPointer > this._sessionHistory.length - 1) {
      return this._sessionHistory.length - 1;
    }

    return this._sessionPointer;
  }

  /**
   * Moves through history using the specified direction
   *
   * @param   {number}  direction  The direction to take. Negative = back, positive = forward
   *
   * @return  {HistoryEntry|null}  The entry navigated to, or null when the
   *                               move was out of bounds
   */
  private _moveThroughHistory(direction: number): HistoryEntry | null {
    // Always make sure the session pointer is valid
    this._sessionPointer = this._normalizedSessionPointer();

    const targetIndex = this._sessionPointer + direction;

    if (targetIndex > this._sessionHistory.length - 1 || targetIndex < 0) {
      console.log("Out of bounds"); // Cannot move: Out of bounds
      return null;
    }

    // Move the pointer
    this._sessionPointer = targetIndex;
    const entry = this._sessionHistory[this._sessionPointer];

    // Open that file, but tell the opener explicitly not to modify the state
    this.openFile(entry.path, false);

    // Return a widened { path, location } copy (both keys always present) so
    // the documents provider can broadcast the exact location to restore.
    return { path: entry.path, location: entry.location };
  }

  /**
   * Sets the pinned status for the given file.
   *
   * @param   {string}   filePath        The absolute path to the file
   * @param   {boolean}  shouldBePinned  Whether the file should be pinned.
   */
  public setPinnedStatus(filePath: string, shouldBePinned: boolean): void {
    const idx = this._openFiles.findIndex((doc) => doc.path === filePath);
    if (idx > -1) {
      this._openFiles[idx].pinned = shouldBePinned;
      this.movePinnedTabsLeft();
    }
  }

  // API METHODS

  /**
   * Returns a JSON serializable representation of the tab manager instance
   *
   * @return  {TabManagerJSON}     The JSON data
   */
  public toJSON(): TabManagerJSON {
    return {
      openFiles: this._openFiles,
      activeFile: this._activeFile,
    };
  }
}

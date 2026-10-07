/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Represents the file system and provides
 *                  an abstraction interface to interact with it.
 *
 * END HEADER
 */

import { hasCodeExt, hasMarkdownExt } from "@common/util/file-extention-checks";
import type {
  AnyDescriptor,
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor,
  OtherFileDescriptor,
  ProjectSettings,
  SortMethod,
} from "@dts/common/fsal";
import type { SearchResult, SearchTerm } from "@dts/common/search";
import type ConfigProvider from "@providers/config";
import type LogProvider from "@providers/log";
import ProviderContract from "@providers/provider-contract";
import type { EventName } from "chokidar/handler.js";
import { app, ipcMain } from "electron";
import EventEmitter from "events";
import { constants as FS_CONSTANTS, promises as fs, lstatSync, type Stats } from "fs";
import path from "path";
import { trans } from "source/common/i18n-main";
import broadcastIPCMessage from "source/common/util/broadcast-ipc-message";
import {
  createIgnoreFilter,
  type IgnoreFilter,
  type IgnoreRuleSources,
  judgingRoot,
  movePathRules,
  removePathRules,
  rulesTextOf,
  setPathIgnored,
  WORKSPACE_RULES_FILE,
} from "source/common/util/ignore-rules";
import _ from "underscore";
import type LongRunningTaskProvider from "../long-running-tasks";
import * as FSALAttachment from "./fsal-attachment";
import FSALCache from "./fsal-cache";
import * as FSALCodeFile from "./fsal-code-file";
import * as FSALDir from "./fsal-directory";
import * as FSALFile from "./fsal-file";
import FSALWatchdog from "./fsal-watchdog";
import getMarkdownFileParser from "./util/file-parser";
import { type FilesystemMetadata, getFilesystemMetadata } from "./util/get-fs-metadata";
import {
  type ListingRules,
  readDirectoryFromDisk,
  readDirectoryRecursivelyFromDisk,
  visibilityChanges,
} from "./util/read-directory";
import { safeDelete } from "./util/safe-delete";

/**
 * The time in which the FSAL collects events for one publication. A burst of
 * watcher events (a render into the workspace, a branch switch) reaches each
 * consumer as one batch.
 */
const EVENT_BATCH_MS = 50;

/** Reads the rules file of a workspace root. A root without one has no rules. */
async function readRulesFile(root: string): Promise<string> {
  try {
    return await fs.readFile(path.join(root, WORKSPACE_RULES_FILE), "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/** Writes the rules file of a workspace root. A root without rules has no file. */
async function writeRulesFile(root: string, text: string): Promise<void> {
  const rulesFile = path.join(root, WORKSPACE_RULES_FILE);
  if (text === "") {
    await fs.rm(rulesFile, { force: true });
  } else {
    await fs.writeFile(rulesFile, text, "utf-8");
  }
}

function sameIgnoreSources(a: IgnoreRuleSources, b: IgnoreRuleSources): boolean {
  return (
    a.showIgnored === b.showIgnored &&
    _.isEqual(a.globalRules, b.globalRules) &&
    _.isEqual([...a.workspaceRules], [...b.workspaceRules])
  );
}

// Re-export all interfaces necessary for other parts of the code (Document Manager)
export {
  type FilesystemMetadata,
  FSALAttachment,
  FSALCodeFile,
  FSALDir,
  FSALFile,
  getFilesystemMetadata,
};

export type FSALEventPayloadUnlink = {
  event: "unlink" | "unlinkDir";
  path: string;
};

export interface FSALEventPayloadChange {
  event: "add" | "addDir" | "change";
  descriptor: AnyDescriptor;
}

export type FSALEventPayload = FSALEventPayloadChange | FSALEventPayloadUnlink;

export default class FSAL extends ProviderContract {
  private readonly _cache: FSALCache;
  private readonly _emitter: EventEmitter;
  private readonly watchers: Map<string, FSALWatchdog>;
  private readonly deadWorkspaces: Set<string>;
  /** The events that wait for the next publication, in the order they happened */
  private readonly pendingEvents: FSALEventPayload[] = [];
  private readonly publishPendingEvents = _.throttle(
    () => {
      const events = this.pendingEvents.splice(0);
      this._emitter.emit("fsal-events", events);
      broadcastIPCMessage("fsal-events", events);
    },
    EVENT_BATCH_MS,
    { leading: false },
  );

  /**
   * The ignore rules the FSAL lists with, and the filter made from them. Both
   * are replaced together and never changed in place.
   */
  private ignoreSources: IgnoreRuleSources = {
    globalRules: [],
    workspaceRules: new Map(),
    showIgnored: false,
  };
  private ignoreFilter: IgnoreFilter = createIgnoreFilter(this.ignoreSources);
  /** The last queued change of the ignore rules. Changes run one after the other. */
  private ignoreUpdate: Promise<void> = Promise.resolve();

  constructor(
    private readonly _logger: LogProvider,
    private readonly _config: ConfigProvider,
    private readonly _lrt: LongRunningTaskProvider,
  ) {
    super();

    const cachedir = app.getPath("userData");
    this._cache = new FSALCache(this._logger, path.join(cachedir, "fsal/cache"));
    this._emitter = new EventEmitter();
    this.watchers = new Map();
    this.deadWorkspaces = new Set();

    ipcMain.handle("fsal", async (event, { command, payload }) => {
      if (command === "read-path-recursively" && typeof payload === "string") {
        if (await this.isFile(payload)) {
          return [payload];
        } else if (await this.isDir(payload)) {
          return await this.readDirectoryRecursively(payload);
        } else {
          return [];
        }
      } else if (command === "read-directory" && typeof payload === "string") {
        return await this.readDirectory(payload);
      } else if (
        command === "get-descriptor" &&
        (typeof payload === "string" ||
          (Array.isArray(payload) && payload.every((p) => typeof p === "string")))
      ) {
        if (Array.isArray(payload)) {
          const descriptors: AnyDescriptor[] = [];
          for (const absPath of payload) {
            // Check every path for existence to ensure an array lookup does not
            // fail.
            if ((await this.isFile(absPath)) || (await this.isDir(absPath))) {
              descriptors.push(await this.getDescriptorFor(absPath));
            } else {
              this._logger.error(
                `[FSAL] Could not provide descriptor for requested path ${absPath}: Neither file nor directory.`,
              );
            }
          }
          return descriptors;
        } else {
          return await this.getDescriptorFor(payload);
        }
      } else if (command === "get-ignore-rules") {
        return this.ignoreSources;
      } else if (
        command === "set-workspace-ignore-rules" &&
        typeof payload?.root === "string" &&
        typeof payload.text === "string"
      ) {
        await this.setWorkspaceIgnoreRules(payload.root, payload.text);
      } else if (
        command === "set-path-ignored" &&
        typeof payload?.path === "string" &&
        typeof payload.isDirectory === "boolean" &&
        typeof payload.ignored === "boolean"
      ) {
        await this.setPathIgnored(payload.path, payload.isDirectory, payload.ignored);
      }
    });
  } // END constructor

  async boot(): Promise<void> {
    this._logger.verbose("FSAL booting up ...");

    // Immediately determine if the cache needs to be cleared
    const shouldClearCache = process.argv.includes("--clear-cache");
    if (this._config.newVersionDetected() || shouldClearCache) {
      this._logger.info("Clearing the FSAL cache ...");
      try {
        await this._cache.clearCache();
        this._logger.info("FSAL cache cleared.");
      } catch (err: unknown) {
        if (err instanceof Error) {
          this._logger.error(`FSAL Cache could not be cleared: ${String(err.message)}`, err);
        }
      }
    }

    // No reindexing here. Since we're booting, and reindexing takes some time,
    // we def this to the application container which can show a splash screen.
    await this.syncRoots();
    this.ignoreSources = await this.readIgnoreSources();
    this.ignoreFilter = createIgnoreFilter(this.ignoreSources);

    this._config.on("update", (which?: string) => {
      if (
        which === "openPaths" ||
        which === "fileManager.ignoreRules" ||
        which === "fileManager.showIgnored"
      ) {
        this.refreshIgnoreRules();
      }

      if (which === "openPaths" || which === "files.dotFiles.showInFilemanager") {
        this.syncRoots()
          .then(() => {
            // Always reindex all files after config updates later on.
            this.reindexFiles().catch((err) =>
              this._logger.error(`[FSAL] Could not reindex files: ${err.message}`, err),
            );
          })
          .catch((err) => {
            this._logger.error(`[FSAL] Could not synchronize paths: ${err.message as string}`, err);
          });
      }
    });
  }

  // Enable global event listening to updates of the config
  on(evt: "fsal-events", callback: (events: FSALEventPayload[]) => void): void {
    this._emitter.on(evt, callback);
  }

  once(evt: "fsal-events", callback: (events: FSALEventPayload[]) => void): void {
    this._emitter.once(evt, callback);
  }

  // Also do the same for the removal of listeners
  off(evt: "fsal-events", callback: (events: FSALEventPayload[]) => void): void {
    this._emitter.off(evt, callback);
  }

  /**
   * Adds an event to the next batch that the FSAL publishes to the main
   * process listeners and to every window.
   *
   * @param   {FSALEventPayload}  payload  The event
   */
  private publishEvent(payload: FSALEventPayload): void {
    this.pendingEvents.push(payload);
    this.publishPendingEvents();
  }

  /**
   * Convenience function for emitting chokidar-related events from the watcher.
   *
   * @param   {EventName}  event    The event name
   * @param   {string}     absPath  The absolute path for this event
   */
  private emitChokidarEvent(event: EventName, absPath: string, stats?: Stats): void {
    if (event === "all" || event === "raw") {
      return this._logger.error(
        '[FSAL] Cannot emit events "all" or "raw" -- wrong chokidar setup!',
      );
    }

    if (event === "ready") {
      return this._logger.verbose("[FSAL] Ignoring ready event.");
    }

    if (event === "error") {
      return this._logger.error(`[FSAL] Chokidar reported an error for path "${absPath}"`);
    }

    if (stats?.isSymbolicLink() === true) {
      return this._logger.error(
        `[FSAL] Ignoring event "${event}" for path "${absPath}" because it is a symbolic link.`,
      );
    }

    // Regardless of the event, it will invalidate that particular cache entry.
    this._cache
      .del(absPath)
      .catch((err) => this._logger.error(`[FSAL Cache] Failed to delete key: ${absPath}`, err));

    if (
      path.basename(absPath) === WORKSPACE_RULES_FILE &&
      this.ignoreSources.workspaceRules.has(path.dirname(absPath))
    ) {
      this.refreshIgnoreRules();
    }

    // A path that the ignore rules hide is not listed, so its events stay
    // here. The event name says whether an unlinked path was a directory.
    if (!this.isListed(absPath, event === "addDir" || event === "unlinkDir")) {
      return;
    }

    // In unlink-events, there won't be a descriptor.
    if (event === "unlink" || event === "unlinkDir") {
      this.publishEvent({ event, path: absPath });
      return;
    }

    // But in any other case (change & add), we should be able to get one.
    this.getDescriptorFor(absPath, false)
      .then((descriptor) => {
        // A `change` can name a directory, and the rules can change while the
        // descriptor loads, so the descriptor decides.
        if (this.isListed(descriptor.path, descriptor.type === "directory")) {
          this.publishEvent({ event, descriptor });
        }
      })
      .catch((err) => {
        this._logger.error(
          `[FSAL] Could not emit event ${event} for path "${absPath}": ${err.message}`,
          err,
        );
      });
  }

  /**
   * Whether the app lists a path: an open workspace root is listed, and any
   * other path is listed unless the ignore rules hide it.
   */
  private isListed(absPath: string, isDirectory: boolean): boolean {
    return (
      this.ignoreSources.workspaceRules.has(absPath) ||
      !this.ignoreFilter.hides(absPath, isDirectory)
    );
  }

  private listingRules(): ListingRules {
    return {
      ignoreDotFiles: !this._config.get().files.dotFiles.showInFilemanager,
      ignoreFilter: this.ignoreFilter,
    };
  }

  /**
   * Reads the ignore rules from their sources: the configuration and the rules
   * file of each open workspace.
   */
  private async readIgnoreSources(): Promise<IgnoreRuleSources> {
    const {
      app: { openWorkspaces },
      fileManager,
    } = this._config.get();
    const workspaceRules = new Map<string, string>();
    for (const root of openWorkspaces) {
      workspaceRules.set(root, await readRulesFile(root));
    }
    return {
      globalRules: [...fileManager.ignoreRules],
      workspaceRules,
      showIgnored: fileManager.showIgnored,
    };
  }

  /**
   * Runs a change of the ignore rules after the changes queued before it. A
   * change reads the rules, so two at once could apply the older reading last.
   */
  private async queueIgnoreUpdate(update: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      await update();
    };
    this.ignoreUpdate = this.ignoreUpdate.then(run, run);
    await this.ignoreUpdate;
  }

  /**
   * Reads the ignore rules again after one of their sources changed.
   */
  private refreshIgnoreRules(): void {
    this.queueIgnoreUpdate(async () => {
      await this.applyIgnoreSources(await this.readIgnoreSources());
    }).catch((err) =>
      this._logger.error(`[FSAL] Could not read the ignore rules: ${String(err.message)}`, err),
    );
  }

  /**
   * Makes the given rules the current ones, sends them to the windows, and
   * publishes what they change as ordinary events: an `unlink` for each path
   * the rules now hide, an `add` for each path they now show. No consumer has
   * to know that a rule, not the disk, changed.
   */
  private async applyIgnoreSources(sources: IgnoreRuleSources): Promise<void> {
    if (sameIgnoreSources(this.ignoreSources, sources)) {
      return;
    }

    const before = this.ignoreFilter;
    this.ignoreSources = sources;
    this.ignoreFilter = createIgnoreFilter(sources);
    broadcastIPCMessage("fsal-ignore-rules", sources);

    const { ignoreDotFiles, ignoreFilter } = this.listingRules();
    const roots = new Set(sources.workspaceRules.keys());
    for (const root of roots) {
      if (this.deadWorkspaces.has(root)) {
        continue;
      }

      for (const change of await visibilityChanges(
        root,
        ignoreDotFiles,
        roots,
        before,
        ignoreFilter,
        this._logger,
      )) {
        if (!change.visible) {
          this.publishEvent({
            event: change.isDirectory ? "unlinkDir" : "unlink",
            path: change.path,
          });
          continue;
        }

        try {
          const descriptor = await this.getDescriptorFor(change.path);
          this.publishEvent({
            event: change.isDirectory ? "addDir" : "add",
            descriptor,
          });
        } catch (err: unknown) {
          this._logger.error(
            `[FSAL] Could not list ${change.path} after an ignore rule change`,
            err,
          );
        }
      }
    }
  }

  /**
   * Changes rules files and applies the result. `edit` receives the text of
   * the rules file of each open workspace and returns the new text of each
   * file that changes.
   */
  private async editRulesFiles(
    edit: (sources: IgnoreRuleSources) => Map<string, string>,
  ): Promise<void> {
    await this.queueIgnoreUpdate(async () => {
      const sources = await this.readIgnoreSources();
      for (const [root, text] of edit(sources)) {
        if (!sources.workspaceRules.has(root)) {
          throw new Error(`[FSAL] Cannot write ignore rules for ${root}: Not an open workspace`);
        }
        await writeRulesFile(root, text);
      }
      await this.applyIgnoreSources(await this.readIgnoreSources());
    });
  }

  /**
   * Returns the ignore rules the FSAL lists with.
   */
  public getIgnoreRuleSources(): IgnoreRuleSources {
    return this.ignoreSources;
  }

  /**
   * Replaces the rules file of an open workspace.
   *
   * @param  {string}  root  The workspace root
   * @param  {string}  text  The new rules, one gitignore line each
   */
  public async setWorkspaceIgnoreRules(root: string, text: string): Promise<void> {
    await this.editRulesFiles(() => new Map([[root, text]]));
  }

  /**
   * Hides one path of a workspace, or shows it again, with a rule in the rules
   * file of the workspace that contains it.
   *
   * @param  {string}   absPath      The file or folder
   * @param  {boolean}  isDirectory  Whether it is a folder
   * @param  {boolean}  ignored      True to hide it, false to show it again
   */
  public async setPathIgnored(
    absPath: string,
    isDirectory: boolean,
    ignored: boolean,
  ): Promise<void> {
    await this.editRulesFiles(({ globalRules, workspaceRules }) => {
      const root = judgingRoot(workspaceRules.keys(), absPath);
      if (root === undefined) {
        throw new Error(
          `[FSAL] Cannot change the ignore rules for ${absPath}: Not inside an open workspace`,
        );
      }
      const text = rulesTextOf(workspaceRules, root);
      return new Map([
        [root, setPathIgnored(text, globalRules, root, absPath, isDirectory, ignored)],
      ]);
    });
  }

  /**
   * Synchronizes the loaded roots with the configuration's openPaths property.
   * This ensures that every path is always watched and events are properly
   * emitted.
   */
  private async syncRoots(): Promise<void> {
    let { openFiles, openWorkspaces } = this._config.get().app;

    // An open file can go missing between two sessions. Removing missing
    // files here prevents errors on boot. Unlike workspaces, the files are
    // removed. (Workspaces can be marked as "dead" so that users don't
    // lose them.)
    const workingOpenFiles: string[] = [];
    for (const file of openFiles) {
      if (await this.isFile(file)) {
        workingOpenFiles.push(file);
      }
    }

    if (workingOpenFiles.length < openFiles.length) {
      const deadCount = openFiles.length - workingOpenFiles.length;
      const deadFiles = [...new Set(openFiles).difference(new Set(workingOpenFiles))];
      this._logger.warning(
        `[FSAL] Discovered ${deadCount} dead standalone files while synchronizing root paths: ${deadFiles.join(", ")}`,
      );
      this._config.set("app.openFiles", workingOpenFiles);
      openFiles = workingOpenFiles;
    }

    const allRoots = openFiles.concat(openWorkspaces);

    for (const rootPath of allRoots) {
      if (this.watchers.has(rootPath)) {
        continue; // This path has already been loaded
      }

      try {
        const descriptor = await this.getDescriptorFor(rootPath, false);
        if (descriptor === undefined) {
          // Mount a "dummy" workspace indicating an unlinked root
          this._logger.error(`Could not load root ${rootPath}. Mounting dummy...`);
          // TODO
        } else {
          // Start watching the root path.
          const watcher = new FSALWatchdog(this._logger, this._config);
          watcher.on("change", (event, absPath, stats) => {
            this.emitChokidarEvent(event, absPath, stats);
          });
          watcher.watchPath(rootPath);
          this.watchers.set(rootPath, watcher);
          this.deadWorkspaces.delete(rootPath);
        }
      } catch (err: unknown) {
        this._logger.error(`Could not load root ${rootPath}.`, err);
        this.deadWorkspaces.add(rootPath);
      }
    }

    // Before finishing up, unwatch all roots that are no longer part of the
    // config
    for (const [rootPath, watcher] of this.watchers) {
      if (!allRoots.includes(rootPath)) {
        await watcher.shutdown();
        this.watchers.delete(rootPath);
      }
    }
  }

  /**
   * This function ensures that all files anywhere within the loaded paths are
   * properly indexed in the cache for fast access.
   */
  public async reindexFiles(onFile?: (absPath: string, percent: number) => void): Promise<void> {
    let currentPercent = 0;

    // Start a timer to measure how long the roots take to load.
    let start = performance.now();

    // Register a LRT. NOTE: We only do that if "onFile" is not defined, because
    // this function is called also from within the lifecycle when the FSAL
    // cache is cleared on startup.
    const task =
      onFile === undefined
        ? this._lrt.registerTask(trans("Indexing files"), trans("Discovering paths to index…"))
        : undefined;

    const { openFiles, openWorkspaces } = this._config.get().app;
    const pathsToIndex: string[] = [];
    for (const file of openFiles) {
      if (!(await this.isFile(file))) {
        this._logger.warning(`[FSAL] Could not re-index standalone file ${file}: File not found.`);
        continue;
      }

      pathsToIndex.push(file);
    }

    for (const workspace of openWorkspaces) {
      if (this.deadWorkspaces.has(workspace)) {
        this._logger.info(`[FSAL] Not re-indexing workspace ${workspace}: Marked as dead`);
        continue;
      }

      if (!(await this.isDir(workspace))) {
        this._logger.warning(`[FSAL] Could not re-index workspace ${workspace}: Folder not found.`);
        continue;
      }

      const allPaths = await this.readDirectoryRecursively(workspace);
      pathsToIndex.push(...allPaths);
    }

    const pathDiscoveryDuration = performance.now() - start;
    if (pathDiscoveryDuration < 1000) {
      this._logger.info(`[FSAL] Discovered paths in ${Math.round(pathDiscoveryDuration)}ms`);
    } else {
      this._logger.info(
        `[FSAL] Discovered paths in ${Math.floor((pathDiscoveryDuration / 1000) * 100) / 100}s`,
      );
    }
    start = performance.now();
    task?.update({
      info: trans("Indexing %s paths…", pathsToIndex.length),
      percentage: 0,
    });

    // Round the increment to 4 digits after the period.
    const roundToDigits = 4;
    const factor = 10 ** roundToDigits;
    const increment = Math.round((100 / pathsToIndex.length) * factor) / factor;

    for (const absPath of pathsToIndex) {
      currentPercent += increment;
      task?.update({ percentage: currentPercent / 100 });
      if (onFile !== undefined) {
        onFile(absPath, currentPercent);
      }

      // Requesting the descriptor will, behind the scenes, check for cache hits
      // and automatically recache if necessary.
      await this.getDescriptorFor(absPath);
    }

    task?.update({ info: trans("Indexing complete.") });
    task?.endTask("success");

    const reindexDuration = performance.now() - start;
    if (reindexDuration < 1000) {
      this._logger.info(`[FSAL] Re-indexed workspaces in ${Math.round(reindexDuration)}ms`);
    } else {
      this._logger.info(
        `[FSAL] Re-indexed workspaces in ${Math.floor((reindexDuration / 1000) * 100) / 100}s`,
      );
    }
  }

  /**
   * Utility function that reads in and returns all descriptors for all loaded
   * paths and workspaces across the app.
   *
   * @return  {Promise<AnyDescriptor>[]}  The descriptors
   */
  public async getAllLoadedDescriptors(): Promise<AnyDescriptor[]> {
    const { openFiles, openWorkspaces } = this._config.get().app;
    const allDescriptors: AnyDescriptor[] = [];

    const reportError = (message: string, err: unknown) => {
      if (err instanceof Error) {
        this._logger.error(`[FSAL] ${message}: ${err.message}`, err);
      } else {
        this._logger.error(`[FSAL] ${message}`, err);
      }
    };

    for (const file of openFiles) {
      try {
        const descriptor = await this.getDescriptorFor(file);
        allDescriptors.push(descriptor);
      } catch (err: unknown) {
        reportError(`Could not load descriptor for root file ${file}`, err);
      }
    }

    for (const workspace of openWorkspaces) {
      if (this.deadWorkspaces.has(workspace)) {
        this._logger.info(
          `[FSAL] Not trying to load descriptors from workspace ${workspace}: Marked as dead`,
        );
        allDescriptors.push(this.loadDummyDirectoryDescriptor(workspace));
        continue;
      }

      try {
        const allPaths = await this.readDirectoryRecursively(workspace);
        for (const child of allPaths) {
          try {
            const descriptor = await this.getDescriptorFor(child);
            allDescriptors.push(descriptor);
          } catch (err: unknown) {
            reportError(`Could not load descriptor for file ${child}`, err);
          }
        }
      } catch (err: unknown) {
        reportError(`Could not read workspace ${workspace}`, err);
      }
    }

    return allDescriptors;
  }

  /**
   * Generates a watchdog that will emit events whenever a path has changed.
   * This abstracts away any watch logic from the rest of the application.
   *
   * @param   {string}        p  The path to be watched
   *
   * @return  {FSALWatchdog}     A new watchdog
   */
  public watchPath(p: string): FSALWatchdog {
    const watcher = this.getWatchdog();
    watcher.watchPath(p);
    return watcher;
  }

  /**
   * Returns a new, empty FSAL watchdog. Add additional paths to watch by
   * calling `watchPath`. NOTE: Try to avoid instantiating empty watchers to
   * avoid conflicts while adding/removing intersecting watched paths, and use
   * `fsal.watchPath` instead!
   *
   * @return  {FSALWatchdog}  A new watchdog
   */
  public getWatchdog(): FSALWatchdog {
    return new FSALWatchdog(this._logger, this._config);
  }

  /**
   * Shuts down the service provider.
   *
   * @returns {boolean} Whether or not the shutdown was successful
   */
  public async shutdown(): Promise<void> {
    this._logger.verbose("FSAL shutting down ...");
    this.publishPendingEvents.cancel();
    await this._cache.persist();
  }

  /**
   * Ever in need for a descriptor mocking a non existing directory? Call this
   * function.
   *
   * @param   {string}         dirPath  The directory path this descriptor
   *                                    should represent
   *
   * @return  {DirDescriptor}           The descriptor
   */
  public loadDummyDirectoryDescriptor(dirPath: string): DirDescriptor {
    return FSALDir.getDirNotFoundDescriptor(dirPath);
  }

  /**
   * Returns an instance with a new file parser. Should be used to retrieve
   * updated versions of the parser whenever the configuration changes
   *
   * @return  {Function}  A parser that can be passed to FSAL functions involving files
   */
  public getMarkdownFileParser(): (file: MDFileDescriptor, content: string) => void {
    return getMarkdownFileParser(this._config.get().zkn.idRE);
  }

  /**
   * Adjusts the sorting setting of the provided directory.
   *
   * @param   {DirDescriptor}     src      The directory
   * @param   {SortMethod}        sorting  The sort method.
   */
  public async changeSorting(src: DirDescriptor, sorting?: SortMethod): Promise<void> {
    await FSALDir.changeSorting(src, sorting);
  }

  /**
   * Loads a given file as a string. May throw an error if the file does not
   * exist or if it is not a text file.
   *
   * @param   {string}           filePath  The file to load
   *
   * @return  {Promise<string>}            Resolves with UTF-8 encoded content.
   */
  public async readTextFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, "utf-8");
  }

  /**
   * Writes a given file using the provided contents. May throw an error if the
   * FSAL cannot write to the given path.
   *
   * @param  {string}  filePath  The file to write
   * @param  {string}  contents  The file contents to put in the file.
   */
  public async writeTextFile(filePath: string, contents: string): Promise<void> {
    // In case this file was cached, remove the cached data again.
    await this._cache.del(filePath);
    await fs.writeFile(filePath, contents, "utf-8");
  }

  /**
   * Tests the access to a given path. Provide the flags as provided in
   * `fs.constants`. By default, this function checks for visibility and whether
   * we can actually read in the node.
   *
   * @return  {Promise<boolean>}  Returns true if the file fulfills the criteria.
   */
  public async testAccess(
    absPath: string,
    flags: number = FS_CONSTANTS.F_OK | FS_CONSTANTS.R_OK,
  ): Promise<boolean> {
    try {
      await fs.access(absPath, flags);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Checks if the provided absolute path is a directory
   *
   * @param   {string}            absPath  The absolute path to the FS node
   *
   * @return  {Promise<boolean>}           Returns true, if absPath is a dir
   */
  public async isDir(absPath: string): Promise<boolean> {
    // A missing entry is the only answer of "no"; any other lstat error throws.
    const stat = lstatSync(absPath, { throwIfNoEntry: false });
    return stat !== undefined && stat.isDirectory();
  }

  /**
   * Checks if the provided absolute path is a file
   *
   * @param   {string}            absPath  The absolute path to the FS node
   *
   * @return  {Promise<boolean>}           Returns true, if absPath is a file
   */
  public async isFile(absPath: string): Promise<boolean> {
    // A missing entry is the only answer of "no"; any other lstat error throws.
    const stat = lstatSync(absPath, { throwIfNoEntry: false });
    return stat !== undefined && stat.isFile();
  }

  /**
   * Creates a new file in the given directory
   *
   * @param  {DirDescriptor}                                           src      The source directory
   * @param  {{ name: string, content: string, type: 'code'|'file' }}  options  Options
   * @deprecated  Use `writeTextFile` instead
   */
  public async createFile(filePath: string, content: string): Promise<void> {
    await this._cache.del(filePath);
    await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
  }

  /**
   * Copies the given source file to the target location.
   *
   * @param  {string}  sourceFile  The source file
   * @param  {string}  targetFile  The target path
   */
  public async copyFile(sourceFile: string, targetFile: string): Promise<void> {
    return await fs.copyFile(sourceFile, targetFile);
  }

  /**
   * Renames the given file. DEPRECATED: Use rename instead.
   *
   * @param  {MDFileDescriptor}  src      The file to be renamed
   * @param  {string}            newName  The new name for the file
   * @deprecated
   */
  public async renameFile(oldPath: string, newPath: string): Promise<void> {
    return await this.rename(oldPath, newPath);
  }

  /**
   * Removes the given file from the system
   *
   * @param   {MDFileDescriptor}  src   The source file
   */
  public async removeFile(filePath: string): Promise<void> {
    const { deleteOnFail } = this._config.get().system;
    // NOTE: This function may be called after a file or folder has been deleted. In that
    // case the function only needs to remove the file or folder from the list of children
    // to avoid safeDelete throwing an error as the file or folder does no longer exist.
    if (await this.pathExists(filePath)) {
      await safeDelete(filePath, deleteOnFail, this._logger);
      await this.editRulesFiles(({ workspaceRules }) => removePathRules(workspaceRules, filePath));
    }
  }

  /**
   * Search the given file
   *
   * @param   {MDFileDescriptor}  src          The file to search
   * @param   {SearchTerm[]}      searchTerms  The search terms
   *
   * @return  {Promise<SearchResult[]>}        Returns the results
   */
  public async searchFile(
    src: MDFileDescriptor | CodeFileDescriptor,
    searchTerms: SearchTerm[],
  ): Promise<SearchResult[]> {
    // TODO: Implement search results type
    // Searches a file and returns the result
    if (src.type === "file") {
      return await FSALFile.search(src, searchTerms);
    } else {
      return await FSALCodeFile.search(src, searchTerms);
    }
  }

  /**
   * Reads in the filenames of the provided directory. May throw an error if the
   * directory cannot be read.
   *
   * @param   {string}             dirPath  The directory to read in
   *
   * @return  {Promise<string[]>}           The files in the directory.
   */
  public async readdir(dirPath: string): Promise<string[]> {
    return await fs.readdir(dirPath, "utf-8");
  }

  /**
   * Sets the given directory settings
   *
   * @param  {DirDescriptor}                       src       The target directory
   * @param  {Partial<DirDescriptor['settings']>}  settings  The settings to apply
   */
  public async setDirectorySetting(
    src: DirDescriptor,
    settings: Partial<DirDescriptor["settings"]>,
  ): Promise<void> {
    await FSALDir.setSetting(src, settings);
  }

  /**
   * Binds the directory to the Quarto manifest that describes it, and derives
   * its project from that manifest.
   *
   * @param   {DirDescriptor}  src           The directory
   * @param   {string}         manifestPath  The manifest the user chose
   *
   * @return  {Promise<FSALDir.QuartoManifestBinding>}  The binding, or why there is none
   */
  public async bindQuartoManifest(
    src: DirDescriptor,
    manifestPath: string,
  ): Promise<FSALDir.QuartoManifestBinding> {
    return await FSALDir.bindQuartoManifest(src, manifestPath);
  }

  /**
   * Removes the directory's binding to a Quarto manifest.
   *
   * @param   {DirDescriptor}  src  The directory
   */
  public async unbindQuartoManifest(src: DirDescriptor): Promise<void> {
    await FSALDir.unbindQuartoManifest(src);
  }

  /**
   * Re-derives a directory's ProjectSettings from its Quarto manifest and
   * publishes the directory's new descriptor. The watcher reports a manifest
   * edit as a change to the manifest file only, never to the directory whose
   * book it describes, so without this event no window sees the new book.
   */
  public async refreshQuartoProject(src: DirDescriptor): Promise<void> {
    await FSALDir.refreshQuartoProject(src);
    this.publishEvent({ event: "change", descriptor: src });
  }

  /**
   * Creates a new project in this dir
   *
   * @param   {DirDescriptor}             src           The directory
   * @param   {Partial<ProjectSettings>}  initialProps  Any initial settings
   */
  public async createProject(
    src: DirDescriptor,
    initialProps: Partial<ProjectSettings>,
  ): Promise<void> {
    await FSALDir.makeProject(src, initialProps);
  }

  /**
   * Updates the given properties for this project
   *
   * @param   {DirDescriptor}    src      The project dir
   * @param   {ProjectSettings}  options  New options
   */
  public async updateProject(src: DirDescriptor, options: ProjectSettings): Promise<void> {
    if (JSON.stringify(src.settings.project) === JSON.stringify(options)) {
      return;
    }
    // Updates the project properties on a directory.
    await FSALDir.updateProjectProperties(src, options);
  }

  /**
   * Deletes the project in this dir
   *
   * @param   {DirDescriptor}  src  The target directory
   */
  public async removeProject(src: DirDescriptor): Promise<void> {
    await FSALDir.removeProject(src);
  }

  /**
   * Creates a new directory
   *
   * @param   {DirDescriptor}  src      Where to create the dir
   * @param   {string}         newName  How to name it
   */
  public async createDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath);
  }

  /**
   * Renames the given directory. DEPRECATED: Use rename instead.
   *
   * @param   {DirDescriptor}  src      The directory to rename
   * @param   {string}         newName  The new name for the dir
   * @deprecated
   */
  public async renameDir(oldPath: string, newPath: string): Promise<void> {
    return await this.rename(oldPath, newPath);
  }

  /**
   * Deletes the given directory
   *
   * @param   {DirDescriptor}  src  The dir to remove
   */
  public async removeDir(dirPath: string): Promise<void> {
    const deleteOnFail: boolean = this._config.get("system.deleteOnFail");
    if (await this.pathExists(dirPath)) {
      await safeDelete(dirPath, deleteOnFail, this._logger);
      await this.editRulesFiles(({ workspaceRules }) => removePathRules(workspaceRules, dirPath));
    }
  }

  /**
   * This function renames or moves a file or folder from oldPath to newPath.
   *
   * @param  {string}  oldPath  The current path of the object
   * @param  {string}  newPath  The wanted new path
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(oldPath, newPath);
    // A rule that names the old path keeps its meaning: a hidden folder stays
    // hidden under its new name.
    await this.editRulesFiles(({ workspaceRules }) =>
      movePathRules(workspaceRules, oldPath, newPath),
    );
  }

  /**
   * Moves a file or directory to its new destination. DEPRECATED: Use rename instead.
   *
   * @param   {MaybeRootDescriptor}  src     What to move
   * @param   {DirDescriptor}        target  Where to move it
   * @deprecated
   */
  public async move(oldPath: string, newPath: string): Promise<void> {
    return await this.rename(oldPath, newPath);
  }

  /**
   * This is a convenience function to retrieve the file contents (as a string)
   * of any file that is supported by Zettlr, meaning you can use this function
   * to load the contents of any Markdown file, any JSON or YAML file, or any
   * TeX file (+ maybe others in the future).
   *
   * @throws When the path was a directory or an unsupported file (unsupported
   *         includes attachments)
   *
   * @param   {string<string>}   absPath  The path to the file
   *
   * @return  {Promise<string>}           Resolves with a string
   */
  public async loadAnySupportedFile(absPath: string): Promise<string> {
    const descriptor = await this.getDescriptorForAnySupportedFile(absPath);

    if (descriptor.type === "file") {
      return await FSALFile.load(descriptor);
    } else if (descriptor.type === "code") {
      return await FSALCodeFile.load(descriptor);
    } else {
      throw new Error(`[FSAL] Cannot load file ${absPath}: Unsupported`);
    }
  }

  /**
   * Convenience function to retrieve a supported file (including attachments
   * in the form of a FSAL descriptor containing metadata on the file in
   * question.)
   *
   * @throws If the path points to a directory or an otherwise unsupported file.
   *
   * @param   {string}   absPath  The path to the file
   *
   * @return  {Promise<MDFileDescriptor>}           Resolves with the descriptor
   *
   * @throws if the path is not a file
   */
  public async getDescriptorForAnySupportedFile(
    absPath: string,
  ): Promise<MDFileDescriptor | CodeFileDescriptor | OtherFileDescriptor> {
    if (await this.isFile(absPath)) {
      if (hasMarkdownExt(absPath)) {
        return await FSALFile.parse(absPath, this._cache, this.getMarkdownFileParser());
      } else if (hasCodeExt(absPath)) {
        return await FSALCodeFile.parse(absPath, this._cache);
      } else {
        return await FSALAttachment.parse(absPath, this._cache);
      }
    }

    if (await this.isDir(absPath)) {
      throw new Error(`[FSAL] Cannot load file ${absPath} as it is a directory`);
    }

    throw new Error(`[FSAL] Cannot load file ${absPath}: Not found`);
  }

  /**
   * Loads any given path (if it exists) into the FSAL descriptor format.
   *
   * @param   {string}   absPath          The path to load
   * @param   {boolean}  avoidDiskAccess  If set to true (the default), attempt
   *                                      to fetch the descriptor directly from
   *                                      the cache, without checking the file
   *                                      system modification status. This means
   *                                      that the returned descriptor may be
   *                                      outdated, but this severely speeds up
   *                                      retrieval speed as it only requires a
   *                                      single access to a `Map`.
   *
   * @return  {Promise<AnyDescriptor>}    Promise resolves with any descriptor
   *
   * @throws if the path does not exist
   */
  public async getDescriptorFor(
    absPath: string,
    avoidDiskAccess: boolean = true,
  ): Promise<AnyDescriptor> {
    if (avoidDiskAccess) {
      const cacheHit = await this._cache.get(absPath);
      if (
        cacheHit !== undefined &&
        (cacheHit.type !== "file" || cacheHit.parserVersion === FSALFile.PARSER_VERSION)
      ) {
        return cacheHit;
      }
    }

    try {
      return await this.getAnyDirectoryDescriptor(absPath);
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "EACCES" || code === "EPERM") {
        return this.loadDummyDirectoryDescriptor(absPath);
      }
      return await this.getDescriptorForAnySupportedFile(absPath);
    }
  }

  /**
   * Returns any directory descriptor. NOTE: If you pass `shallow` as true, do
   * not assume that the `children`-list of the directory is always empty!
   *
   * @param   {string}                  absPath  The path to the directory
   *
   * @return  {Promise<DirDescriptor>}           The dir descriptor
   *
   * @throws if the path is not a directory
   */
  public async getAnyDirectoryDescriptor(absPath: string): Promise<DirDescriptor> {
    if (this.deadWorkspaces.has(absPath)) {
      return this.loadDummyDirectoryDescriptor(absPath);
    }

    if (!(await this.isDir(absPath))) {
      throw new Error(`[FSAL] Cannot load directory ${absPath}: Not a directory`);
    }

    return await FSALDir.parse(absPath);
  }

  /**
   * Checks if a given path exists on the file system. Optional flags can be
   * passed to check specific access rights. By default, will check for general
   * access (i.e., the process can see the file), and read access, but not write
   * access. Use fs.constants as flags.
   *
   * @param   {string}            absPath  The path to check
   * @param   {number|undefined}  flags    Optional mode check flags
   *
   * @return  {Promise<boolean>}           Resolves to true or false
   */
  public async pathExists(
    absPath: string,
    flags: number = FS_CONSTANTS.F_OK | FS_CONSTANTS.R_OK,
  ): Promise<boolean> {
    try {
      await fs.access(absPath, flags);
      return true;
    } catch (err: unknown) {
      return false;
    }
  }

  /**
   * Returns an object with fundamental file system metadata for the provided
   * absPath. May throw on error.
   *
   * @param   {string}                       absPath  The path to access.
   *
   * @return  {Promise<FilesystemMetadata>}           Returns the metadata.
   * @throws
   */
  public async getFilesystemMetadata(absPath: string): Promise<FilesystemMetadata> {
    return await getFilesystemMetadata(absPath);
  }

  // *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***

  /**
   * Reads `absPath` into an array of absolute paths. If `absPath` is a file,
   * the array will only contain that, allowing you to skip any check for
   * whether a root path is a file or folder. If it is a directory, it will read
   * in the directory and any children recursively to construct a list of every
   * file and folder within `absPath` and return it.
   *
   * NOTE: This function will already exclude dotfiles, ignored directories and
   * the paths that the ignore rules hide, so this function is safe to consume
   * in terms of what Zettlr should display.
   *
   * @param   {string}             directoryPath  The absolute path to parse
   *
   * @return  {Promise<string[]>}           Returns a list of the entire directory
   */
  public async readDirectoryRecursively(directoryPath: string): Promise<string[]> {
    if (!(await this.isDir(directoryPath))) {
      throw new Error(`[FSAL] Cannot read path ${directoryPath}: Not a directory!`);
    }

    return await readDirectoryRecursivelyFromDisk(directoryPath, this.listingRules(), this._logger);
  }

  /**
   * Reads a single directory from disk and returns a list of its children as
   * descriptors.
   *
   * @param   {string}                    absPath  The directory path.
   *
   * @return  {Promise<AnyDescriptor>[]}           The children.
   */
  public async readDirectory(absPath: string): Promise<AnyDescriptor[]> {
    return await readDirectoryFromDisk(
      absPath,
      this.listingRules(),
      this.deadWorkspaces.has(absPath),
      async (childPath) => await this.getDescriptorFor(childPath),
      this._logger,
    );
  }
}

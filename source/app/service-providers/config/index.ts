/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ConfigProvider
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class provides getters and setters for the configuration
 *                  of the whole application.
 *
 * END HEADER
 */

import { loadData, trans } from "@common/i18n-main";
import PersistentDataContainer, {
  type StoreWriteFailureHandler,
} from "@common/modules/persistent-data-container";
import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import enumDictFiles from "@common/util/enum-dict-files";
import { reportError } from "@common/util/error-reporting";
import { hasMdOrCodeExt } from "@common/util/file-extention-checks";
import { ignorePath } from "@common/util/ignore-path";
import isDir from "@common/util/is-dir";
import isFile from "@common/util/is-file";
import safeAssign from "@common/util/safe-assign";
import { app, dialog, ipcMain } from "electron";
import EventEmitter from "events";
import { realpathSync } from "fs";
import { DateTime } from "luxon";
import path from "path";
import type LogProvider from "../log";
import ProviderContract from "../provider-contract";
import { type ConfigJsonValue, type ValidationRule, validationRules } from "./config-validation";
import {
  type ConfigOptions,
  type ConfigPath,
  type ConfigValue,
  getConfigTemplate,
  systemAppLang,
} from "./get-config-template";
import { showOnboardingWindow } from "./onboarding-window";
import { consolidateRootPaths, rootPathsOnDisk } from "./root-paths";

const ZETTLR_VERSION = app.getVersion();

type ConfigRecord = { [key: string]: ConfigJsonValue };

function isConfigRecord(value: ConfigJsonValue): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Finds the object that holds the option at a dotted path, and the option's
 * key in that object.
 *
 * @throws {Error} If the configuration has no option at that path.
 */
function locateOption(config: ConfigRecord, option: string): { holder: ConfigRecord; key: string } {
  const segments = option.split(".");
  const key = segments.pop();
  let holder: ConfigJsonValue = config;
  for (const segment of segments) {
    holder = isConfigRecord(holder) ? holder[segment] : undefined;
  }
  if (key === undefined || !isConfigRecord(holder) || !(key in holder)) {
    throw new Error(`The configuration has no option "${option}".`);
  }
  return { holder, key };
}

/**
 * Asserts that a dotted path from another process names an option.
 *
 * @throws {Error} If the configuration has no option at that path.
 */
function assertConfigPath(config: ConfigOptions, option: string): asserts option is ConfigPath {
  locateOption(config, option);
}

/**
 * A config.json as an earlier version may have written it: a subset of the
 * current options, plus the keys that `runMigrations` rewrites.
 */
type StoredConfig = Partial<Omit<ConfigOptions, "app" | "fileManager">> & {
  app?: Partial<ConfigOptions["app"]>;
  fileManager?: Partial<ConfigOptions["fileManager"]> & {
    filePicker?: { include?: string[] } | null;
  };
  openPaths?: string[];
};

/**
 * The following options require a relaunch after being changed. NOTE: These are
 * implemented as a Map that we can access and save the state whether a dialog
 * has already been shown for this option so that we don't pesker users.
 */
const guardOptions = {
  relaunch: new Map<string, boolean>([
    ["appLang", false],
    ["window.nativeAppearance", false],
    ["window.vibrancy", false],
    ["watchdog.activatePolling", false],
    ["zkn.idRE", false],
    // The FSAL reads the links of each file with it at the start
    ["zkn.linkFormat", false],
  ]),
  // The following options additionally require a clearing of the cache
  clearCache: new Map<string, boolean>([["zkn.idRE", false]]),
  // The following options only require the editors to reload, since they are,
  // e.g., required by one of the extensions.
  reloadEditors: [
    "zkn.linkFormat", // Requires a reload since required by the parser that has no access to the editor config
  ],
};

/**
 * This class represents the configuration of Zettlr, represented by the
 * config.json file in the user's data directory as well as some environment
 * variables. Basically, this class tells Zettlr what the user wants and what
 * the environment Zettlr is running in is capable of.
 */
export default class ConfigProvider extends ProviderContract {
  /**
   * The absolute path to the used configuration
   *
   * @var {string}
   */
  private readonly configFile: string;
  /**
   * Contains a set of validation rules
   *
   * @var {ValidationRule[]}
   */
  private readonly _rules: ValidationRule[];
  /**
   * Contains the actual configuration
   *
   * @var {ConfigOptions}
   */
  private config: ConfigOptions;
  /**
   * A flag indicating whether the provider thinks this is a first start
   *
   * @var {boolean}
   */
  private _firstStart: boolean;
  /**
   * A flag indicating whether the provider thinks the user has just updated
   *
   * @var {boolean}
   */
  private _newVersion: boolean;

  /**
   * Holds the data container responsible for writing the data to disk
   *
   * @var {PersistentDataContainer}
   */
  private readonly _container: PersistentDataContainer<ConfigOptions>;

  private readonly _emitter: EventEmitter;

  /**
   * Preset sane defaults, then load the config and perform a system check.
   * @param {string[]} translationDirectories The directories of the translations; the interface language of the template is one of them.
   * @param {StoreWriteFailureHandler} onWriteFailure What happens when a write of config.json fails.
   */
  constructor(
    private readonly _logger: LogProvider,
    translationDirectories: string[],
    onWriteFailure: StoreWriteFailureHandler,
  ) {
    super();
    this.configFile = path.join(app.getPath("userData"), "config.json");

    this._emitter = new EventEmitter(); // Initiate the emitter

    this.config = getConfigTemplate(systemAppLang(translationDirectories));
    this._rules = validationRules();
    this._firstStart = false; // Only true if a config file has been created
    this._newVersion = false; // True if the last read config had a different version

    this._container = new PersistentDataContainer(this.configFile, "json", onWriteFailure);

    // Listen for renderer events. These must be synchronous.
    ipcMain.on("config-provider", (event, message) => {
      const { command, payload } = message;

      if (command === "get-config") {
        if (payload === undefined) {
          event.returnValue = this.get();
          return;
        }
        const key: string = payload.key;
        assertConfigPath(this.config, key);
        event.returnValue = this.get(key);
      } else if (command === "set-config-single") {
        // A synchronous sender waits for a return value, so a refusal goes
        // back to it as the reason instead of as an exception in this process.
        try {
          const key: string = payload.key;
          assertConfigPath(this.config, key);
          this.set(key, payload.val);
          event.returnValue = null;
        } catch (err) {
          if (!(err instanceof Error)) {
            throw err;
          }
          event.returnValue = err.message;
        }
      }
    });

    // Handle config events
    ipcMain.handle("config-provider", (event, message) => {
      const { command } = message;

      if (command === "set-config") {
        // Sets the complete config object
        const { payload } = message;
        for (const opt in payload) {
          assertConfigPath(this.config, opt);
          this.set(opt, payload[opt]);
        }
        return true;
      }
    });
  }

  isFirstStart(): boolean {
    return this._firstStart;
  }

  newVersionDetected(): boolean {
    return this._newVersion;
  }

  /**
   * Shutdown the service provider -- here save the config to disk
   * @return {Boolean} Returns true after successful shutdown.
   */
  async shutdown(): Promise<void> {
    this._logger.verbose("Config provider shutting down ...");
    await this._container.shutdown();
  }

  /**
   * Boots the provider
   */
  async boot(): Promise<void> {
    this._logger.verbose("Config provider booting up ...");

    if (!(await this._container.isInitialized())) {
      this._logger.info("No configuration detected: Assuming first start and new version!");
      // The config is not yet initialized, so we know this is a firstStart.
      this._firstStart = true;
      this._newVersion = true;
      await this._container.init(this.config);
    } else {
      this._logger.verbose("Loading configuration ...");
      // The container has already been initialized, so it's not a first start.
      // Pull in the config and do our thing.
      const readConfig = await this._container.get();

      // Determine if this is a different version
      this._newVersion = readConfig.version !== this.config.version;
      const oldVersion = readConfig.version;

      // Additional check for nightlies, because these do not differ in terms of
      // build version, but rather in terms of build date.
      const isNightly = this.config.version.endsWith("-nightly");
      const buildDatesDiffer = this.config.buildDate !== readConfig.buildDate;
      if (!this._newVersion && isNightly && buildDatesDiffer) {
        // Below's check errs on the side of caution and assigns newVersion true
        // if unsure.
        const oldDate = DateTime.fromISO(readConfig.buildDate ?? this.config.buildDate);
        const newDate = DateTime.fromISO(this.config.buildDate);
        this._newVersion = newDate >= oldDate;
      }

      // Run potential migrations on the (old) read configuration from disk
      // before merging with the correct config template. This allows the
      // migrations to modify certain properties if necessary.
      this.runMigrations(readConfig);

      // NOTE: We cannot use "update" here because we cannot yet broadcast any
      // events, so we have to use safeAssign directly.
      this.config = safeAssign(readConfig, this.config);

      // Don't forget to update the version
      if (this._newVersion) {
        this._logger.info(`Migrating from ${oldVersion} to ${String(this.config.version)}!`);
        this.config.version = ZETTLR_VERSION; // We should not emit events here, so manually set the value
        this.config.buildDate = __BUILD_DATE__;
      }
    }

    // Remove potential dead links to non-existent files and dirs
    this.checkPaths();

    // Immediately begin loading the translation strings. These have to be
    // available directly after the config has been loaded.
    const file = await loadData(this.config.appLang);
    // It may be that only a fallback has been provided or else. In this case we
    // must update the config to reflect this.
    if (file.tag !== this.config.appLang) {
      this.config.appLang = file.tag;
    }

    // Now for the fun part: Show a brand new onboarding experience.
    if (this._firstStart || this._newVersion) {
      await showOnboardingWindow(this, this._logger, this._firstStart ? "first-start" : "update");
    }
  }

  // Enable global event listening to updates of the config
  // An "update" names the changed option; a whole-config update names none.
  on(evt: string, callback: (option?: string) => void): void {
    this._emitter.on(evt, callback);
  }

  // Also do the same for the removal of listeners
  off(evt: string, callback: (option?: string) => void): void {
    this._emitter.off(evt, callback);
  }

  /**
   * This function is used to run migrations on the read config when the user
   * updates to a new version. It modifies the read configuration object in
   * place so that it can then be merged into the correct config template.
   *
   * @param  {StoredConfig}  readConfig  The read config from disk.
   */
  private runMigrations(readConfig: StoredConfig): void {
    // The Ctrl+Shift+P picker used to own a separate permanent extension
    // filter. File visibility now has one authority: the file manager's
    // permanent filters, which the picker consumes as a subset. Preserve the
    // user's exact include list while renaming the persisted key.
    if (
      typeof readConfig.fileManager === "object" &&
      readConfig.fileManager !== null &&
      typeof readConfig.fileManager.filePicker === "object" &&
      readConfig.fileManager.filePicker !== null &&
      readConfig.fileManager.filters === undefined
    ) {
      readConfig.fileManager.filters = {
        include: Array.isArray(readConfig.fileManager.filePicker.include)
          ? readConfig.fileManager.filePicker.include
          : [],
      };
      delete readConfig.fileManager.filePicker;
    }

    // After version 4.0.0, we have split up `openPaths` into separate file and
    // workspaces arrays. Only a configuration written before 4.0.0 has
    // `openPaths`, and such a configuration has no `app` section.
    if (readConfig.openPaths !== undefined) {
      readConfig.app = {
        openFiles: readConfig.openPaths.filter((absPath) => isFile(absPath)),
        openWorkspaces: readConfig.openPaths.filter((absPath) => isDir(absPath)),
      };
    } // END: openPaths migration
  }

  /**
   * Checks the validity of each path that should be opened and removes all
   * those that are invalid.
   */
  checkPaths(): void {
    // Remove duplicates
    this.config.app.openFiles = [...new Set(this.config.app.openFiles)];
    this.config.app.openWorkspaces = [...new Set(this.config.app.openWorkspaces)];

    // Check for the existence of the files and folders
    const onDisk = rootPathsOnDisk(this.config.app, (rootPath, error) => {
      this._logger.error(
        `[Config Provider] Could not examine the root path ${rootPath}. It stays in the configuration: ${error.message}`,
        error,
      );
    });
    this.config.app.openFiles = onDisk.openFiles;
    this.config.app.openWorkspaces = onDisk.openWorkspaces;

    // Now sort the paths.
    this.sortPaths();

    const dicts = enumDictFiles().map((item) => item.tag);

    // We have to run over the spellchecking dictionaries and see whether or
    // not they are still valid or if they have been deleted.
    for (let i = 0; i < this.config.selectedDicts.length; i++) {
      if (!dicts.includes(this.config.selectedDicts[i])) {
        this.config.selectedDicts.splice(i, 1);
        --i;
      }
    }
  }

  /**
   * Removes each open file that an open workspace holds: the workspace lists
   * it already. A workspace inside another workspace stays open.
   */
  private consolidateRootPaths(): void {
    const { openFiles, openWorkspaces } = consolidateRootPaths(this.config.app);
    this.config.app.openFiles = openFiles;
    this.config.app.openWorkspaces = openWorkspaces;
    this._container.set(this.config); // Persist changes
  }

  /**
   * Sorts the paths prior to using them alphabetically and by type.
   * @return {ZettlrConfig} Chainability.
   */
  private sortPaths(): void {
    const { openFiles, openWorkspaces } = this.config.app;
    const { sortWorkspacesManually } = this.config.fileManager;

    // We only want to sort the paths based on rudimentary, natural order.
    const coll = new Intl.Collator([this.get("appLang"), "en"], { numeric: true });

    openFiles.sort((a, b) => {
      return coll.compare(path.basename(a), path.basename(b));
    });
    this.config.app.openFiles = openFiles;

    // Only sort the workspaces if the user did not override the order manually.
    if (!sortWorkspacesManually) {
      openWorkspaces.sort((a, b) => {
        return coll.compare(path.basename(a), path.basename(b));
      });
      this.config.app.openWorkspaces = openWorkspaces;
    }

    this._container.set(this.config);
  }

  /**
   * Adds a path to be opened on startup. The root is named by its real
   * path, as at start (`rootPathsOnDisk`).
   * @param {String} requestedPath The path to be added
   * @return {Boolean} True, if the path was successfully added, else false.
   */
  addPath(requestedPath: string): boolean {
    if (!isFile(requestedPath) && !isDir(requestedPath)) {
      return false;
    }
    const p = realpathSync(requestedPath);
    const { openFiles, openWorkspaces } = this.config.app;
    // Only add valid and unique paths
    if (openFiles.includes(p) || openWorkspaces.includes(p)) {
      return false;
    }

    const validFile = isFile(p) && hasMdOrCodeExt(p);
    const validDir = isDir(p);

    if (!ignorePath(p) && (validFile || validDir)) {
      if (validFile) {
        this.config.app.openFiles.push(p);
      } else {
        this.config.app.openWorkspaces.push(p);
      }

      this.consolidateRootPaths();
      this.sortPaths();
      this._container.set(this.config);
      this._emitter.emit("update", "openPaths");
      broadcastIpcMessage("config-provider", { command: "update", payload: "openPaths" });
      return true;
    }

    return false;
  }

  /**
   * Removes a path from the startup paths
   * @param  {String} p The path to be removed
   * @return {Boolean} Whether or not the call succeeded.
   */
  removePath(p: string): boolean {
    const { openFiles, openWorkspaces } = this.config.app;
    const fileIdx = openFiles.indexOf(p);
    const wsIdx = openWorkspaces.indexOf(p);
    const rootFile = fileIdx > -1;
    const workspace = wsIdx > -1;

    if (rootFile || workspace) {
      if (rootFile) {
        this.config.app.openFiles.splice(fileIdx, 1);
      } else {
        this.config.app.openWorkspaces.splice(wsIdx, 1);
      }
      this._container.set(this.config);
      this._emitter.emit("update", "openPaths");
      broadcastIpcMessage("config-provider", { command: "update", payload: "openPaths" });
      return true;
    }

    return false;
  }

  /**
   * Returns a config property
   *
   * @param  {string}             attr  The property to return
   * @return {any|ConfigOptions}        Either the config property or null
   */
  get(): ConfigOptions;
  get<P extends ConfigPath>(attr: P): ConfigValue<P>;
  get(attr?: string): ConfigOptions | ConfigJsonValue {
    if (attr === undefined) {
      return this.getConfig();
    }
    const { holder, key } = locateOption(this.config, attr);
    return holder[key];
  }

  /**
   * Simply returns the complete config object.
   *
   * @return {ConfigOptions} The configuration object.
   */
  getConfig(): ConfigOptions {
    return this.config;
  }

  /**
   * Sets a configuration option
   * @param  {string}   option      The dotted path of the option to be set
   * @param  {any}      value       The value of the config variable.
   * @param  {boolean}  skipChecks  For internal use only. Do not use.
   * @throws {Error}                If the option does not exist or its rule refuses the value.
   */
  set<P extends ConfigPath>(option: P, value: ConfigValue<P>, skipChecks?: boolean): void;
  set(option: string, value: ConfigJsonValue, skipChecks = false): void {
    const { holder, key } = locateOption(this.config, option);
    const rule = this._rules.find((candidate) => candidate.getKey() === option);
    if (rule !== undefined && !rule.validate(value)) {
      throw new Error(rule.why());
    }
    if (holder[key] === value) {
      return;
    }

    holder[key] = value;
    this._container.set(this.config);
    this._emitter.emit("update", option);
    broadcastIpcMessage("config-provider", { command: "update", payload: option });
    if (skipChecks) {
      return;
    }
    this.checkOptionForGuard(option);
    // This option affects the order that the provider itself keeps.
    if (
      option === "fileManager.sortWorkspacesManually" &&
      !this.config.fileManager.sortWorkspacesManually
    ) {
      this.sortPaths();
    }
  }

  /**
   * After setting an option, this function checks if the provided option is
   * guarded. There are various layers of "guards". Some require a full restart
   * of the app, others only require a reload cycle of the main editor(s). This
   * function ensures that this happens, e.g., by emitting appropriate events or
   * asking the user if they want to restart now.
   *
   * @param   {string}  option  The configuration option to check
   */
  private checkOptionForGuard(option: string): void {
    // Some settings require all editors to perform a full reload
    if (guardOptions.reloadEditors.includes(option)) {
      broadcastIpcMessage("reload-editors");
    }

    // If the option is not guarded or the dialog has already been asked,
    // quietly return.
    const opt = guardOptions.relaunch.get(option);
    if (opt === undefined || opt) {
      return;
    }

    guardOptions.relaunch.set(option, true);

    dialog
      .showMessageBox({
        message: trans("Changing this option requires a restart to take effect."),
        type: "warning",
        buttons: [trans("Restart now"), trans("Restart later")],
        defaultId: 0,
        cancelId: 1,
        title: trans("Confirm"),
      })
      .then(({ response }) => {
        if (response === 0) {
          // The user wants to restart now
          if (guardOptions.clearCache.has(option)) {
            // Ensure the cache is cleared on relaunch
            app.relaunch({ args: process.argv.slice(1).concat(["--clear-cache"]) });
          } else {
            app.relaunch();
          }
          app.quit();
        }
      })
      .catch((err) => reportError(err));
  }

  /**
   * Update the complete configuration object with new values
   * @param  {Object} newcfg               The new object containing new props
   * @return {void}                      Does not return anything.
   */
  update(newcfg: Partial<ConfigOptions>): void {
    // Use safeAssign to make sure only properties from the config
    // are retained, and no rogue values (which can also simply be
    // old deprecated values).
    this.config = safeAssign(newcfg, this.config);
    this._emitter.emit("update"); // Emit an event to all listeners
    // Broadcast to all open windows
    broadcastIpcMessage("config-provider", { command: "update", payload: undefined });
    this._container.set(this.config);
  }
}

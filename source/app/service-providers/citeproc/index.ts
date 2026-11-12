/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Citeproc Provider
 * CVM-Role:    Service Provider
 * Maintainer:  Hendrik Erz
 * License:     GNU GPL v3
 *
 * Description:     This class represents an interface between the citeproc-js
 *                  library, a Zotero generated BibLaTeX file (ideally in CSL
 *                  JSON), and your texts in Markdown.
 *
 * END HEADER
 */

import { FSWatcher } from "chokidar";
import CSL from "citeproc";
import { app, ipcMain } from "electron";
import { constants as FS_CONSTANTS, promises as fs, readFileSync } from "fs";
import path from "path";
import type LogProvider from "../log";
import ProviderContract, { type IPCMessage } from "../provider-contract";

/**
 * The configuration surface this provider consumes: the update signal, and
 * the three settings it reads. Declared narrow, following the ReferenceProvider
 * pattern (../references/index.ts), so that a member added here is a compile
 * error at every injection site -- depending on the whole ConfigProvider would
 * hide that, and force injectors to satisfy members this provider never touches.
 */
export interface CiteprocConfig {
  on: (evt: "update", callback: (option?: string) => void) => void;
  get: () => { appLang: string; export: { cslLibrary: string; cslStyle: string } };
}

import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import isFile from "@common/util/is-file";
import type { CitationDatabase, CitationResourceProblem } from "@dts/common/citeproc";
import { CITEPROC_MAIN_DB, CITEPROC_PROBLEMS_CHANNEL } from "@dts/common/citeproc";
import { loadDatabaseOnThread } from "./util/load-database-on-thread";
import {
  type CslCitationFormat,
  parseCslStyleMetadata,
  supportsNarrativeComposite,
} from "./util/style-metadata";

export interface DatabaseRecord {
  path: string;
  // We basically have CSL databases (do not contain attachments) or BibTex
  // (contain attachments).
  type: "csl" | "bibtex" | "biblatex";
  cslData: Record<string, CSLItem>;
  bibtexAttachments: Record<string, string[] | false>;
}

export type CiteprocIPCContract = {
  "get-items": {
    request: { payload: { database: CitationDatabase } };
    response: CSLItem[];
  };
  "get-citation": {
    request: { payload: { database: CitationDatabase; citations: CiteItem[]; composite: boolean } };
    response: string | undefined;
  };
  "get-bibliography": {
    request: { payload: { database: CitationDatabase; citations: string[] } };
    response: [BibliographyOptions, string[]] | undefined;
  };
  "get-problems": {
    request: { payload?: undefined };
    response: CitationResourceProblem[];
  };
};

// get-citation-sync rides ipcMain.on/sendSync, not invoke, so it is not part
// of the invoke contract above.
export type CiteprocSyncCitationResponse =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

export type CiteprocProviderIPCAPI =
  | IPCMessage<CiteprocIPCContract>
  | {
      command: "get-citation-sync";
      payload: { database: CitationDatabase; citations: CiteItem[]; composite: boolean };
    };

// The default style Zettlr ships with
const DEFAULT_CHICAGO_STYLE = path.join(__dirname, "./assets/csl-styles/chicago-author-date.csl");

/**
 * The CSL locales of the built app: the build copies `static/csl-locales`
 * beside the main bundle (webpack.main.config.js).
 */
export const BUNDLED_LOCALE_DIRECTORY = path.join(__dirname, "./assets/csl-locales");

/**
 * The thread program of a database load in the built app: the entry
 * `database-loader-worker` of the main bundle (webpack.main.config.js).
 */
export const BUNDLED_DATABASE_LOADER_THREAD = path.join(__dirname, "database-loader-worker.cjs");

const CITEPROC_EMPTY_SENTINELS = [
  "[NO_PRINTED_FORM]",
  "[CSL STYLE ERROR: reference with no printed form.]",
] as const;

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class CiteprocRenderInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiteprocRenderInvariantError";
  }
}

/** The style of `export.cslStyle` did not load, so the provider renders nothing. */
export class CitationStyleError extends Error {
  constructor(problem: CitationResourceProblem) {
    super(`The citation style ${problem.path} could not be loaded: ${problem.cause}`);
    this.name = "CitationStyleError";
  }
}

/** A database file that the provider does not have, and why. */
export interface DatabaseNotLoaded {
  path: string;
  cause: string;
}

/**
 * Whether the provider has the items of one database. `not-configured`: the
 * request names the main library and the settings name none.
 */
export type DatabaseAvailability =
  | { state: "loaded" }
  | { state: "not-configured" }
  | ({ state: "not-loaded" } & DatabaseNotLoaded);

/** A read of a database file that runs on a thread. */
interface RunningLoad {
  /**
   * Ends when no read of the database runs and the provider has the result
   * of the last one: a record, or a problem. It does not reject for a file
   * that does not load.
   */
  ended: Promise<void>;
  /** Stops the read. The provider drops the result of a stopped read. */
  stop: AbortController;
}

/** An engine and the style that made it. */
interface LoadedStyle {
  path: string;
  engine: CSL.Engine;
  /** CSL-declared citation format used to choose semantically valid modes. */
  citationFormat: CslCitationFormat | undefined;
}

/**
 * This class enables to export citations from a CSL JSON file to HTML.
 */
export default class CiteprocProvider extends ProviderContract {
  /**
   * The main library which is being used everywhere where we don't have
   * specific libraries. This variable holds the absolute path.
   *
   * @var {string}
   */
  private mainLibrary: string;

  /**
   * This property ensures we do not do double-work if a database should be
   * selected that has already been selected
   *
   * @var {string}
   */
  private lastSelectedDatabase: string;

  /**
   * The engine of the configured style. `undefined` while that style has a
   * problem: the provider then renders nothing, also not in the style of an
   * earlier setting.
   */
  private style: LoadedStyle | undefined;
  /** Counts the style loads. The result of a load that a later one replaced is dropped. */
  private styleLoads = 0;
  private styleProblem: CitationResourceProblem | undefined;
  /** The cause of the last failed read of each database that is not loaded. */
  private readonly databaseProblems = new Map<string, string>();
  /** The problems that the windows have. */
  private broadcastProblems: CitationResourceProblem[] = [];
  /**
   * This array contains all available databases, including the main one.
   *
   * @var {DatabaseRecord[]}
   */
  private readonly databases: Map<string, DatabaseRecord>;
  /** The read that runs for a database. A request for that database waits for it. */
  private readonly loading = new Map<string, RunningLoad>();
  /** The checks of awaitMainLibraryItem calls. Each runs after every database load. */
  private readonly loadListeners = new Set<() => void>();

  /**
   * This hashmap contains a mapping of citekeys --> CSLItems for quick access
   * by the CSL engine.
   *
   * @var {Object}
   */
  private _items: Record<string, CSLItem>;

  /**
   * Just like the FSAL, the citeproc provider maintains a watcher for citation
   * files. If they change, or are unlinked, the provider can react to them.
   *
   * @var {FSWatcher}
   */
  private readonly _watcher: FSWatcher;

  /**
   * This is the kernel that is being used by the CSL engine to retrieve both
   * CSL items and a locale file.
   *
   * @var {CSLKernel}
   */
  private readonly sys: CSLKernel;

  constructor(
    private readonly _logger: LogProvider,
    private readonly _config: CiteprocConfig,
    /** The one directory that holds the CSL locales (`locales-<lang>.xml`). */
    private readonly _localeDirectory: string,
    /** The thread program that reads a database (`util/database-loader-worker`). */
    private readonly _loaderThread: string,
  ) {
    super();

    this._items = {};
    this.lastSelectedDatabase = "";
    this.mainLibrary = "";

    // Start the watcher
    this._watcher = new FSWatcher({
      persistent: true,
      ignoreInitial: true,
      // See for the following property the file source/main/modules/fsal/fsal-watchdog.ts
      interval: 5000,
      // Databases can become quite large, so we have to wait for it to finish
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    // The provider watches each database from its first read, also one that
    // did not load. Each event is a reason to read the file again: the read
    // gives the record of a written file and the problem of a removed one.
    // The record of the text before the change stays until the read ends.
    this._watcher.on("all", (eventName, affectedPath) => {
      this._logger.info(`[Citeproc Provider] ${affectedPath}: ${eventName}. Reading it again ...`);
      this.startLoad(affectedPath, false).catch((err: unknown) => {
        this._logger.error(
          `[Citeproc Provider] The read of ${affectedPath} did not end: ${causeText(err)}`,
          err,
        );
      });
    });

    this.databases = new Map(); // Holds all currently loaded databases

    // The sys kernel is required by the citeproc processor
    this.sys = {
      retrieveLocale: (lang: string) => {
        return this.getLocale(lang);
      },
      retrieveItem: (id: string) => {
        return this._items[id];
      },
    };

    // Be notified of potential updates
    this._config.on("update", (option?: string) => {
      this.onConfigUpdate(option);
    });

    /**
     * Listen for events coming from the citation renderer of the MarkdownEditor
     */
    ipcMain.on("citeproc-provider", (event, message: CiteprocProviderIPCAPI) => {
      const { command, payload } = message;
      if (command === "get-citation-sync") {
        const { database, citations, composite } = payload;
        // This call cannot wait for a read. A window can ask before the
        // documents provider named the bibliography of a new document; the
        // read starts here, and the window draws again when it ends.
        this.startMissingLoads(database);
        try {
          event.returnValue = {
            ok: true,
            value: this.getCitation(database, citations, composite),
          } satisfies CiteprocSyncCitationResponse;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this._logger.error(
            `[Citeproc Provider] Synchronous citation rendering failed: ${message}`,
            error,
          );
          event.returnValue = { ok: false, error: message } satisfies CiteprocSyncCitationResponse;
        }
      }
    });

    /**
     * Listen to renderer requests
     */
    ipcMain.handle("citeproc-provider", async (event, message: CiteprocProviderIPCAPI) => {
      if (message.command === "get-problems") {
        return this.problems();
      }
      const { command, payload } = message;
      const { database } = payload;
      // A database that does not load is a problem that the windows show.
      if (!(await this.databasesAvailable(database))) {
        return command === "get-items" ? [] : undefined;
      }

      if (command === "get-items") {
        this.selectDatabase(database);
        return Object.values(this._items);
      } else if (command === "get-citation") {
        const { citations, composite } = payload;
        return this.getCitation(database, citations, composite);
      } else if (command === "get-bibliography") {
        const { citations } = payload;
        // The Payload contains the items the renderer wants to have
        return this.makeBibliography(database, citations);
      }
    });
  } // END constructor

  /**
   * The database paths that a citation database names. The sentinel
   * CITEPROC_MAIN_DB names the globally configured library, and
   * `export.cslLibrary` is optional: the sentinel gives the path of that
   * library when one is configured and loaded, and gives nothing otherwise.
   */
  private databasePaths(database: CitationDatabase): string[] {
    const requestedPaths = Array.isArray(database) ? database : [database];
    return requestedPaths
      .filter((databasePath) => databasePath !== CITEPROC_MAIN_DB || this.hasMainLibrary())
      .map((databasePath) => (databasePath === CITEPROC_MAIN_DB ? this.mainLibrary : databasePath));
  }

  public hasBibTexAttachments(database: CitationDatabase): boolean {
    return this.databasePaths(database).some((dbPath) => {
      const db = this.databases.get(dbPath);
      return db !== undefined && Object.keys(db.bibtexAttachments).length > 0;
    });
  }

  /**
   * The attachment files of a citation that are on disk, in the order of the
   * library. A library can name a file that is absent: Zotero's BibTeX export
   * writes a file name without its braces and doubled spaces. `false`: the
   * library names no file for the citation.
   */
  public getBibTexAttachments(database: CitationDatabase, id: string): string[] | false {
    for (const dbPath of this.databasePaths(database)) {
      const attachments = this.databases.get(dbPath)?.bibtexAttachments[id];
      if (attachments !== undefined) {
        return attachments === false ? false : attachments.filter((file) => isFile(file));
      }
    }
    return false;
  }

  /**
   * Metadata for every loaded bibliography database. Does not expose items;
   * call {@link getItems} for that.
   */
  public listDatabases(): Array<{ path: string; type: DatabaseRecord["type"] }> {
    return Array.from(this.databases.values()).map((db) => ({
      path: db.path,
      type: db.type,
    }));
  }

  /** Each database file that the provider keeps and whose last read failed, with the cause. */
  public databasesNotLoaded(): DatabaseNotLoaded[] {
    return Array.from(this.databaseProblems, ([databasePath, cause]) => ({
      path: databasePath,
      cause,
    }));
  }

  /**
   * Whether the provider has the items of a database. The provider reads the
   * library of the settings and the bibliographies of the open documents and
   * Projects; this call reads no other file.
   */
  public databaseAvailability(database: string): DatabaseAvailability {
    const databasePath = database === CITEPROC_MAIN_DB ? this.mainLibrary : database;
    if (databasePath === "") {
      return { state: "not-configured" };
    }
    if (this.databases.has(databasePath)) {
      return { state: "loaded" };
    }
    const problem = this.databaseProblems.get(databasePath);
    if (problem !== undefined) {
      return { state: "not-loaded", path: databasePath, cause: problem };
    }
    if (this.loading.has(databasePath)) {
      return {
        state: "not-loaded",
        path: databasePath,
        cause: "The read of the file has not ended.",
      };
    }
    return {
      state: "not-loaded",
      path: databasePath,
      cause:
        "The app does not read this file: it reads the library of the settings and the bibliographies of the open documents and Projects.",
    };
  }

  /** The cite keys of a request that the databases do not hold, in the order of the request. */
  public missingCitekeys(database: CitationDatabase, citekeys: string[]): string[] {
    this.selectDatabase(database);
    return citekeys.filter((key) => !(key in this._items));
  }

  /**
   * All CSL items from the requested database(s), merged with earlier
   * databases taking precedence on duplicate keys — the same semantics as
   * the renderer's IPC `get-items` call.
   */
  public getItems(database: CitationDatabase): CSLItem[] {
    this.selectDatabase(database);
    return Object.values(this._items);
  }

  /**
   * A single CSL item by cite key, or undefined when the key does not exist
   * in the requested database(s).
   */
  public getItem(database: CitationDatabase, citeKey: string): CSLItem | undefined {
    this.selectDatabase(database);
    return this._items[citeKey];
  }

  /**
   * Whether the loaded main library contains the cite key. While the provider
   * reads a changed library again, the library has the keys of the text
   * before the change. During its first read it has no key.
   */
  public mainLibraryHas(citeKey: string): boolean {
    const record = this.databases.get(this.mainLibrary);
    return record !== undefined && citeKey in record.cslData;
  }

  /**
   * Whether the main library contains the cite key now or after a load that
   * ends within timeoutMs. An item added to Zotero reaches the main library
   * only when Better BibTeX exports the library again and the watcher reloads
   * it.
   */
  public async awaitMainLibraryItem(citeKey: string, timeoutMs: number): Promise<boolean> {
    if (this.mainLibraryHas(citeKey)) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const check = (): void => {
        if (!this.mainLibraryHas(citeKey)) {
          return;
        }
        clearTimeout(timer);
        this.loadListeners.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.loadListeners.delete(check);
        resolve(false);
      }, timeoutMs);
      this.loadListeners.add(check);
    });
  }

  public async boot(): Promise<void> {
    this._logger.verbose("Citeproc provider booting up ...");
    this.mainLibrary = this._config.get().export.cslLibrary;

    await this.loadEngine();

    if (this.mainLibrary === "") {
      return;
    }

    // The start does not wait for the library: the read takes seconds for a
    // large library, and the windows open during it. Each window draws its
    // citations again when the library arrives.
    this.startLoadInBackground(this.mainLibrary);
  }

  /** Ends when no read of a database runs. */
  public async loadsEnded(): Promise<void> {
    while (this.loading.size > 0) {
      await Promise.all([...this.loading.values()].map((load) => load.ended));
    }
  }

  /**
   * The files that the provider needs and that did not load: the style and
   * the library of the citation settings, and each bibliography of a document
   * or a Quarto book. A window shows them to the author: no window is open
   * when the provider starts, so each window asks for them (`get-problems`),
   * and a change of this list goes to the open windows on
   * CITEPROC_PROBLEMS_CHANNEL.
   */
  public problems(): CitationResourceProblem[] {
    const problems: CitationResourceProblem[] = [];
    if (this.styleProblem !== undefined) {
      problems.push(this.styleProblem);
    }
    for (const [databasePath, cause] of this.databaseProblems) {
      problems.push({
        resource: databasePath === this.mainLibrary ? "library" : "bibliography",
        path: databasePath,
        cause,
      });
    }
    return problems;
  }

  private publishProblems(): void {
    const problems = this.problems();
    if (JSON.stringify(problems) === JSON.stringify(this.broadcastProblems)) {
      return;
    }
    this.broadcastProblems = problems;
    broadcastIpcMessage(CITEPROC_PROBLEMS_CHANNEL, problems);
  }

  /**
   * Directs the provider to keep these databases, and the main library,
   * available, and no other. The last call decides: before this call gives
   * its first turn to another one, the provider drops each other database
   * with its running read and its problem, and starts the read of each new
   * one. The reads run at the same time, so a file that does not load stops
   * no other file; it becomes a problem (`problems`). Ends when the reads
   * ended.
   *
   * @param  {string[]}  dbPaths  The absolute paths to the libraries
   */
  public async synchronizeDatabases(dbPaths: string[]): Promise<void> {
    const known = new Set([
      ...this.databases.keys(),
      ...this.loading.keys(),
      ...this.databaseProblems.keys(),
    ]);
    for (const dbPath of known) {
      if (dbPath !== this.mainLibrary && !dbPaths.includes(dbPath)) {
        this.unloadDatabase(dbPath);
      }
    }
    await Promise.all(dbPaths.map(async (dbPath) => await this.loadDatabase(dbPath)));
  }

  /**
   * Loads the engine of the configured style. `export.cslStyle` is the only
   * citation-style setting of the application, so the editor renders in it
   * too, not only the exporter.
   *
   * A style of the author that does not load is a problem of the provider:
   * the app runs, the windows name the path and the cause, and no citation is
   * rendered until the style loads. The bundled style is not used in its
   * place: the document would show a style that the settings do not name.
   * The bundled style and the locales are resources of the app; their
   * failure rejects.
   */
  private async loadEngine(): Promise<void> {
    const load = ++this.styleLoads;
    const configuredStyle = this._config.get().export.cslStyle;
    if (configuredStyle === "") {
      const bundled = await this.readStyle(DEFAULT_CHICAGO_STYLE);
      this.applyStyle(load, bundled, undefined);
      return;
    }

    await this.readStyle(configuredStyle).then(
      (style) => this.applyStyle(load, style, undefined),
      (cause: unknown) => {
        if (this.isLocaleFailure(cause)) {
          throw cause;
        }
        this._logger.error(
          `[Citeproc Provider] Could not load CSL style ${configuredStyle}: ${causeText(cause)}`,
          cause,
        );
        this.applyStyle(load, undefined, {
          resource: "style",
          path: configuredStyle,
          cause: causeText(cause),
        });
      },
    );
  }

  /** Takes the result of a style load, unless a later load started after it. */
  private applyStyle(
    load: number,
    style: LoadedStyle | undefined,
    problem: CitationResourceProblem | undefined,
  ): void {
    if (load !== this.styleLoads) {
      return;
    }
    this.style = style;
    this.styleProblem = problem;
    this.publishProblems();
    // Each rendered citation of a window is of the style before this one.
    broadcastIpcMessage("citeproc-database-updated", CITEPROC_MAIN_DB);
  }

  private async readStyle(stylePath: string): Promise<LoadedStyle> {
    this._logger.info(`[Citeproc Provider] Loading CSL style at ${stylePath} ...`);
    const source = await fs.readFile(stylePath, "utf-8");
    const citationFormat = parseCslStyleMetadata(source).citationFormat;

    // The last parameter enforces usage of the language we provide
    const engine = new CSL.Engine(this.sys, source, this._config.get().appLang, true);
    // ATTENTION: This is a development extension we're using to auto-wrap
    // links and DOIs in a-tags so that the user can click them in the
    // bibliography. Remove if it becomes unstable and implement manually.
    engine.opt.development_extensions.wrap_url_and_doi = true;
    // Empty citeproc output is an invariant failure. Without this option,
    // citeproc-js literally returns '[NO_PRINTED_FORM]' as if it were content.
    engine.opt.development_extensions.throw_on_empty = true;
    return { path: stylePath, engine, citationFormat };
  }

  /** The read failure of a file in the locale directory, which the engine reads while it loads a style. */
  private isLocaleFailure(cause: unknown): boolean {
    return (
      cause instanceof Error &&
      "path" in cause &&
      typeof cause.path === "string" &&
      path.dirname(cause.path) === this._localeDirectory
    );
  }

  /** The engine of the configured style. Throws while that style has a problem. */
  private requireStyle(): LoadedStyle {
    if (this.style !== undefined) {
      return this.style;
    }
    if (this.styleProblem === undefined) {
      throw new Error("The citation provider renders before its start loaded a style.");
    }
    throw new CitationStyleError(this.styleProblem);
  }

  /**
   * Whether the provider has each database of a request, after the reads
   * that run for them ended. A database that the provider did not read gets
   * its first read. The main library is not required: the request of a
   * document names it also when no library is configured or loaded, and then
   * gets the items of the other databases.
   */
  private async databasesAvailable(database: CitationDatabase): Promise<boolean> {
    const requested = Array.isArray(database) ? database : [database];
    await Promise.all(
      requested.map(async (databasePath) =>
        databasePath === CITEPROC_MAIN_DB
          ? await this.loading.get(this.mainLibrary)?.ended
          : await this.loadDatabase(databasePath),
      ),
    );
    return requested.every(
      (databasePath) => databasePath === CITEPROC_MAIN_DB || this.databases.has(databasePath),
    );
  }

  /**
   * Ends when the provider has the database or the problem of its file. A
   * loaded database is not read again, so a request does not wait while the
   * provider reads a changed file. A database with a problem is not read
   * again either: the watcher reads it when its file changes.
   */
  private async loadDatabase(databasePath: string): Promise<void> {
    if (this.databases.has(databasePath) || this.databaseProblems.has(databasePath)) {
      return;
    }
    const running = this.loading.get(databasePath);
    await (running !== undefined ? running.ended : this.startLoad(databasePath, true));
  }

  /** Starts the first read of each database of a request that the provider does not know. */
  private startMissingLoads(database: CitationDatabase): void {
    for (const databasePath of Array.isArray(database) ? database : [database]) {
      if (
        databasePath !== CITEPROC_MAIN_DB &&
        !this.databases.has(databasePath) &&
        !this.databaseProblems.has(databasePath) &&
        !this.loading.has(databasePath)
      ) {
        this.startLoadInBackground(databasePath);
      }
    }
  }

  /** Starts a read that no caller waits for. */
  private startLoadInBackground(databasePath: string): void {
    this.startLoad(databasePath, true).catch((err: unknown) => {
      this._logger.error(
        `[Citeproc Provider] The read of ${databasePath} did not end: ${causeText(err)}`,
        err,
      );
    });
  }

  /**
   * Starts a read of a database file on a thread and stops the read that
   * runs for that file: its text is the text before a change. The record
   * that the provider has stays until this read ends, so a window that draws
   * a citation during the read finds the library.
   *
   * @param   {string}   databasePath  The path to load the database from
   * @param   {boolean}  watch         Whether to watch the file for changes
   *
   * @return  {Promise<void>}          The `ended` of the read
   */
  private startLoad(databasePath: string, watch: boolean): Promise<void> {
    this.loading.get(databasePath)?.stop.abort();
    if (watch) {
      this._watcher.add(databasePath);
    }

    const stop = new AbortController();
    const ended = this.readDatabase(databasePath, stop.signal).then(
      async (record) => {
        if (stop.signal.aborted) {
          await this.laterLoadEnded(databasePath, stop);
        } else {
          this.loading.delete(databasePath);
          this.takeRecord(databasePath, record);
        }
      },
      async (cause: unknown) => {
        if (stop.signal.aborted) {
          await this.laterLoadEnded(databasePath, stop);
        } else {
          this.loading.delete(databasePath);
          this.takeFailure(databasePath, cause);
        }
      },
    );
    this.loading.set(databasePath, { ended, stop });
    return ended;
  }

  /** Ends when the read that replaced a stopped read ended. */
  private async laterLoadEnded(databasePath: string, stopped: AbortController): Promise<void> {
    const current = this.loading.get(databasePath);
    if (current !== undefined && current.stop !== stopped) {
      await current.ended;
    }
  }

  /** The record of a database file, read on a thread. */
  private async readDatabase(databasePath: string, stop: AbortSignal): Promise<DatabaseRecord> {
    // The cause of an absent or unreadable file is the error of the system.
    await fs.access(databasePath, FS_CONSTANTS.R_OK);
    return await loadDatabaseOnThread(
      this._loaderThread,
      { databasePath, cacheDir: path.join(app.getPath("userData"), "citeproc-cache") },
      this._logger,
      stop,
    );
  }

  /** Makes the record of a read the database of its path. */
  private takeRecord(databasePath: string, record: DatabaseRecord): void {
    // Label styles print `citation-label`, and citeproc invents one from the
    // author names when the item carries none -- BibTeX and BibLaTeX have no
    // field that maps to it. The citekey IS the label the author writes and
    // reads, so it is the label to print. This runs once per load, on the
    // in-memory record: the parse cache on disk keeps holding exactly what the
    // file says, and citeproc sees the same item object on every retrieval,
    // which its cluster-wide disambiguation requires.
    for (const [id, item] of Object.entries(record.cslData)) {
      if (item["citation-label"] === undefined) {
        item["citation-label"] = id;
      }
    }

    this.databases.set(databasePath, record);
    this.setDatabaseProblem(databasePath, undefined);
    this.broadcastDatabaseUpdate(databasePath);
    for (const check of [...this.loadListeners]) {
      check();
    }
  }

  /**
   * Records the failed read of a database. The provider drops the record of
   * the text before: it is not the text of the file. The file stays watched,
   * so the provider reads it again when it changes.
   */
  private takeFailure(databasePath: string, cause: unknown): void {
    this._logger.error(
      `[Citeproc Provider] Could not load database ${databasePath}: ${causeText(cause)}`,
      cause,
    );
    if (this.databases.delete(databasePath)) {
      this.broadcastDatabaseUpdate(databasePath);
    }
    this.setDatabaseProblem(databasePath, causeText(cause));
  }

  private setDatabaseProblem(databasePath: string, cause: string | undefined): void {
    if (cause === undefined) {
      this.databaseProblems.delete(databasePath);
    } else {
      this.databaseProblems.set(databasePath, cause);
    }
    this.publishProblems();
  }

  /** Tells the windows that the items of a database changed. */
  private broadcastDatabaseUpdate(databasePath: string): void {
    broadcastIpcMessage(
      "citeproc-database-updated",
      databasePath === this.mainLibrary ? CITEPROC_MAIN_DB : databasePath,
    );
  }

  /**
   * Drops a database: its record, its running read, its problem and its
   * watch.
   *
   * @param   {string}  dbPath  The database file path
   */
  private unloadDatabase(dbPath: string): void {
    this.loading.get(dbPath)?.stop.abort();
    this.loading.delete(dbPath);
    this._watcher.unwatch(dbPath);
    this.setDatabaseProblem(dbPath, undefined);
    if (this.databases.delete(dbPath)) {
      this._logger.info(`[Citeproc Provider] Unloading database ${dbPath}`);
      this.broadcastDatabaseUpdate(dbPath);
    }
  }

  /**
   * Selects another database and activates it.
   *
   * @param   {string}  dbPath  The database to select
   */
  private selectDatabase(database: CitationDatabase): void {
    // An empty selection selects no items -- the same state as a library
    // holding nothing -- rather than an error.
    const paths = this.databasePaths(database);
    const identity = paths.join("\u0000");
    const items: Record<string, CSLItem> = {};

    for (const databasePath of paths) {
      const record = this.databases.get(databasePath);
      if (record === undefined) {
        throw new Error(`Could not select database ${databasePath}: Not loaded.`);
      }

      for (const [citekey, item] of Object.entries(record.cslData)) {
        if (!(citekey in items)) {
          items[citekey] = item;
        }
      }
    }

    if (this.lastSelectedDatabase !== identity) {
      this._logger.verbose(`[Citeproc Provider] Selecting database ${paths.join(", ")}...`);
    }

    this._items = items;

    // Remove the items from the registry. Without a style there is no registry.
    if (this.style !== undefined) {
      this.style.engine.updateItems([]);
    }
    this.lastSelectedDatabase = identity;
  }

  /**
   * Shuts down the service provider
   */
  async shutdown(): Promise<void> {
    this._logger.verbose("Citeproc provider shutting down ...");
    // A read that runs owns a thread. The thread ends with the provider.
    const reads = [...this.loading.values()];
    this.loading.clear();
    for (const read of reads) {
      read.stop.abort();
    }
    await Promise.all(reads.map((read) => read.ended));
    // We MUST under all circumstances properly call the close() function on
    // every chokidar process we utilize. Otherwise, the fsevents dylib will
    // still hold on to some memory after the Electron process itself shuts down
    // which will result in a crash report appearing on macOS.
    await this._watcher.close();
  }

  /**
   * There has been a config update. In case the main library has changed, reload
   */
  onConfigUpdate(option?: string): void {
    if (option === "appLang" || option === "export.cslStyle") {
      // We have to reload the engine to reflect the new language or style. A
      // style of the author that does not load is a problem that the windows
      // show; this rejection is the failure of a resource of the app.
      this.loadEngine().catch((err) =>
        this._logger.error(`[Citeproc Provider] Could not reload engine: ${causeText(err)}`, err),
      );
    } else if (option === "export.cslLibrary") {
      // Determine if we have to reload
      const newValue = this._config.get().export.cslLibrary;

      if (newValue !== this.mainLibrary) {
        // The library that the setting named before goes with its problem.
        if (this.mainLibrary !== "") {
          this.unloadDatabase(this.mainLibrary);
        }
        this.mainLibrary = newValue;
        // A bibliography with a problem that the setting now names is the
        // library with that problem.
        this.publishProblems();
        if (this.mainLibrary.trim() === "") {
          return; // The user removed the csl library
        }

        // A main library that does not load is a problem that the windows show.
        this.startLoadInBackground(this.mainLibrary);
      }
    }
  }

  /**
   * The CSL locale of a language, from the locale directory of this provider.
   * `false` says that the directory has no locale of that language; the
   * engine then uses a more general locale, at the end en-US. The en-US
   * locale is required, so its read failure is an error, as is each failure
   * other than an absent file.
   * See https://citeproc-js.readthedocs.io/en/latest/running.html#retrievelocale
   *
   * @param   {string}          lang  The language to be loaded.
   * @return  {string|boolean}        Either the contents of the XML file, or false.
   */
  private getLocale(lang: string): string | false {
    if (lang === "us") {
      // From the docs: "The function _must_ return a value for the us locale."
      lang = "en-US";
    }

    const localePath = path.join(this._localeDirectory, `locales-${lang}.xml`);
    if (lang !== "en-US" && !isFile(localePath)) {
      return false;
    }
    this._logger.info(`[Citeproc Provider] Loading CSL locale file at ${localePath} ...`);
    return readFileSync(localePath, { encoding: "utf8" });
  }

  /**
   * PUBLIC FUNCTIONS
   */

  /**
   * Takes IDs as set in Zotero and returns Author-Date citations for them.
   *
   * @param  {string}            database   The database in which to search
   * @param  {CiteItem[]}        citations  Array containing the IDs to be returned
   * @param  {boolean}           composite  If true, getCitation will mimic the "mode: composite" feature of processCitationCluster
   *
   * @return {string|undefined}             The rendered string
   */
  getCitation(
    database: CitationDatabase,
    citations: CiteItem[],
    composite: boolean = false,
  ): string | undefined {
    if (citations.length === 0) {
      return undefined; // Nothing to render
    }

    if (!this.hasRequestedDatabases(database)) {
      return undefined;
    }

    // Make sure we have the correct database loaded. Missing citekeys are an
    // ordinary unresolved-citation state; a citeproc render failure is not.
    this.selectDatabase(database);
    const citekeys = citations.map((c) => c.id);
    if (!this.ensureCitekeysExist(citekeys)) {
      this._logger.verbose(
        `[CiteprocProvider] Cannot render citation with citekeys ${citekeys.join(", ")}: At least one key does not exist in database ${database}`,
      );
      return undefined;
    }

    const style = this.requireStyle();
    style.engine.updateItems(citekeys);
    const useComposite =
      composite && citations.length === 1 && supportsNarrativeComposite(style.citationFormat);
    const mode: EngineCitation["properties"]["mode"] = useComposite ? "composite" : undefined;
    const citation: EngineCitation = {
      citationItems: citations.map((item) => ({ ...item })),
      properties: { noteIndex: 0, mode },
    };

    try {
      const rendered = style.engine.previewCitationCluster(citation, [], [], "html");
      return this.assertPrintableCitation(rendered, citekeys, composite, mode);
    } catch (error) {
      const contextual = this.renderInvariantError("citation", citekeys, error);
      this._logger.error(contextual.message, error);
      throw contextual;
    }
  }

  private assertPrintableCitation(
    rendered: string,
    citekeys: string[],
    requestedComposite: boolean,
    mode: EngineCitation["properties"]["mode"],
  ): string {
    if (
      rendered.trim() === "" ||
      CITEPROC_EMPTY_SENTINELS.some((sentinel) => rendered.includes(sentinel))
    ) {
      throw this.renderInvariantError(
        "citation",
        citekeys,
        new Error(
          `citeproc returned non-printable output ${JSON.stringify(rendered)} (requestedComposite=${requestedComposite}, engine mode=${String(mode)})`,
        ),
      );
    }
    return rendered;
  }

  private renderInvariantError(
    kind: "citation" | "bibliography",
    citekeys: string[],
    cause: unknown,
  ): CiteprocRenderInvariantError {
    if (cause instanceof CiteprocRenderInvariantError) {
      return cause;
    }
    return new CiteprocRenderInvariantError(
      `Could not render ${kind} for [${citekeys.join(", ")}] with style ${JSON.stringify(this.style?.path)}: ${causeText(cause)}`,
    );
  }

  /**
   * Directs the engine to create a bibliography from the items currently in the
   * registry (this can be updated by calling updateItems with an array of IDs.)
   *
   * @param  {string}    database  The database to use for creating the bibliography
   * @param  {string[]}  citekeys  The citekeys to use for creating the bibliography
   *
   * @return {[BibliographyOptions, string[]]|undefined} A CSL object containing the bibliography.
   */
  makeBibliography(
    database: CitationDatabase,
    citekeys: string[],
  ): [BibliographyOptions, string[]] | undefined {
    if (citekeys.length === 0) {
      return undefined;
    }

    if (!this.hasRequestedDatabases(database)) {
      return undefined;
    }

    this.selectDatabase(database);
    const sanitizedCitekeys = this.filterNonExistingCitekeys(citekeys);
    if (sanitizedCitekeys.length === 0) {
      return undefined;
    }
    const style = this.requireStyle();
    style.engine.updateItems(sanitizedCitekeys);
    try {
      const bibliography = style.engine.makeBibliography();
      if (bibliography === undefined || bibliography[1].length === 0) {
        throw new Error("citeproc returned no bibliography entries");
      }
      for (const entry of bibliography[1]) {
        if (
          entry.trim() === "" ||
          CITEPROC_EMPTY_SENTINELS.some((sentinel) => entry.includes(sentinel))
        ) {
          throw new Error(
            `citeproc returned non-printable bibliography entry ${JSON.stringify(entry)}`,
          );
        }
      }
      return bibliography;
    } catch (error) {
      const contextual = this.renderInvariantError("bibliography", sanitizedCitekeys, error);
      this._logger.error(contextual.message, error);
      throw contextual;
    }
  }

  /**
   * Whether a render for this request has databases to read. It has none
   * when the request names only the main library and no main library is
   * loaded, and when it names a database that the provider reads for the
   * first time or whose file did not load: the windows draw their citations
   * again when the database arrives, and a file that did not load is a
   * problem that they show.
   */
  private hasRequestedDatabases(database: CitationDatabase): boolean {
    if (database === CITEPROC_MAIN_DB) {
      return this.hasMainLibrary();
    }
    const requested = Array.isArray(database) ? database : [database];
    return !requested.some(
      (databasePath) =>
        databasePath !== CITEPROC_MAIN_DB &&
        !this.databases.has(databasePath) &&
        (this.loading.has(databasePath) || this.databaseProblems.has(databasePath)),
    );
  }

  /**
   * Checks whether a main library is available
   *
   * @return  {boolean} True if there is
   */
  hasMainLibrary(): boolean {
    return this.mainLibrary !== "" && this.databases.has(this.mainLibrary);
  }

  /**
   * This function returns false if at least one provided citekey does not exist
   * in the currently selected database. Can be called after selecting a
   * database to ensure the CSLEngine does not throw errors if a key does not
   * exist.
   *
   * @param   {string[]}  citekeys  The citekeys to check
   *
   * @return  {boolean}             Returns false if one or more citekeys don't
   *                                exist in the selected database.
   */
  private ensureCitekeysExist(citekeys: string[]): boolean {
    for (const key of citekeys) {
      if (!(key in this._items)) {
        return false;
      }
    }

    return true;
  }

  /**
   * In instances where a few undefined citekeys are allowed, such as generating
   * the bibliography, this function simply removes those that don't exist
   * instead of requiring all of them to exist.
   *
   * @param   {string[][]}  citekeys  The unfiltered citekeys
   *
   * @return  {string[]}              The list of keys that exist in the database
   */
  private filterNonExistingCitekeys(citekeys: string[]): string[] {
    return citekeys.filter((key) => key in this._items);
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SearchProvider
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Finds and replaces across the loaded workspaces. The
 *                  query, the matching and the previews are the pure half
 *                  in util/search-query; this walks the workspaces, reads
 *                  each file (an open Markdown document through the
 *                  authority, so what is matched is what the editor shows),
 *                  broadcasts what it finds file by file, and applies a
 *                  replace through the journaled workspace-edit transaction
 *                  the reference rename owns. A file that the filesystem
 *                  refuses to read does not stop a search: the search reads
 *                  the other files and names that file with the cause.
 *
 * END HEADER
 */

import { hashDocumentSource } from "@common/pandoc-util/extract-references";
import type { WorkspaceTextEdit } from "@dts/common/references";
import { ipcMain } from "electron";
import path from "path";
import broadcastIPCMessage from "source/common/util/broadcast-ipc-message";
import isErrnoException from "source/common/util/is-errno-exception";
import { innermostRoot } from "source/common/util/renderer-path-polyfill";
import vm from "vm";
import type { ConfigOptions } from "../config/get-config-template";
import type DocumentManager from "../documents";
import type FSAL from "../fsal";
import type LogProvider from "../log";
import type ProviderContract from "../provider-contract";
import type { IPCMessage } from "../provider-contract";
import {
  runWorkspaceEditTransaction,
  saveUpdatedBuffers,
  type WorkspaceEditAuthority,
} from "../references/workspace-edit-transaction";
import { compilePathFilter } from "./util/search-globs";
import {
  compileQuery,
  expandReplacement,
  matchDocument,
  type SearchMatch,
  type SearchQuery,
} from "./util/search-query";

export type { SearchMatch, SearchQuery } from "./util/search-query";

/** One file's matches, as the view lists them. */
export type FileSearchResult = {
  documentPath: string;
  /** The hash of the text the matches were found in; a replace is fenced on it. */
  sourceHash: string;
  /** Whether a replace may address this file: only Markdown documents. */
  replaceable: boolean;
  matches: SearchMatch[];
};

/**
 * One document's matches to replace: the spans as the search reported them
 * and the hash of the text they were found in, which the replace is fenced
 * on — a document that changed since the search is refused, not guessed at.
 */
export interface ReplaceTarget {
  documentPath: string;
  sourceHash: string;
  ranges: Array<{ from: number; to: number }>;
}

/**
 * A file that the search did not read, or a folder whose files it did not
 * read because the filesystem refused its content, with the cause.
 */
export interface UnsearchedFile {
  documentPath: string;
  kind: "file" | "folder";
  cause: string;
}

/** What a search has of one file: its text, the cause of no text, or no text type. */
type SearchSource =
  | { kind: "text"; source: string; replaceable: boolean }
  | { kind: "not-searched"; cause: string }
  | { kind: "no-text" };

/** What the search of one file gave. */
type FileSearchOutcome =
  | { kind: "matches"; result: FileSearchResult }
  | { kind: "no-matches" }
  | { kind: "not-searched"; file: UnsearchedFile };

/** A search run to completion for the agent API. */
export type WorkspaceSearchOutcome =
  | {
      status: "ok";
      results: FileSearchResult[];
      matchCount: number;
      truncated: boolean;
      /** The files and the folders that the search did not read. */
      notSearched: UnsearchedFile[];
    }
  | { status: "invalid-query"; message: string }
  | { status: "timeout"; documentPath: string };

export type ReplaceOutcome =
  | { status: "applied"; documentsChanged: string[]; matchesReplaced: number }
  | { status: "conflict"; documentPath: string };

export type UndoReplaceOutcome = ReplaceOutcome | { status: "nothing-to-undo" };

export type SearchProviderIPCContract = {
  "start-full-text-search": {
    request: { payload: { query: SearchQuery } };
    response: number;
  };
  "cancel-search": {
    request: { payload?: undefined };
    response: undefined;
  };
  "replace-in-files": {
    request: { payload: { targets: ReplaceTarget[]; replacement: string; preserveCase: boolean } };
    response: ReplaceOutcome;
  };
  "undo-last-replace": {
    request: { payload?: undefined };
    response: UndoReplaceOutcome;
  };
};

export type SearchProviderIPCAPI = IPCMessage<SearchProviderIPCContract>;

/**
 * The messages this provider broadcasts on the 'search-provider' channel
 * while a search runs. The provider is the single owner of this type; the
 * Search view imports it to type its listener.
 */
/**
 * Why a search could not run, or stopped before the end of its queue. The
 * view reads these out where it would otherwise read out a result count. A
 * file that the filesystem refuses to read is no failure of the search: it
 * arrives as `search-unread`, and the search goes on.
 */
export type SearchFailure =
  | { kind: "invalid-query"; message: string }
  | { kind: "stopped"; documentPath: string; message: string };

export type SearchProviderBroadcast =
  | { type: "search-end"; generation: number }
  | { type: "search-result"; generation: number; result: FileSearchResult; progress: number }
  | { type: "search-progress"; generation: number; progress: number }
  | { type: "search-unread"; generation: number; file: UnsearchedFile; progress: number }
  | { type: "search-failed"; generation: number; failure: SearchFailure };

export class SearchProvider implements ProviderContract {
  /** How many files this search will read, for the progress it reports. */
  private sumFilesToSearch: number;
  /** The absolute paths still to read. */
  private fileSearchQueue: string[];
  /** The search running now, or undefined between searches. */
  private currentSearch: { pattern: RegExp; generation: number } | undefined;
  /**
   * Every search gets a number, and a result carrying a stale one is
   * dropped: a query typed one character at a time starts a search per
   * character, and the one still arriving from two characters ago must not
   * reach the view.
   */
  private searchGeneration: number;
  /** The query the last search ran with; a replace expands against its pattern. */
  private lastPattern: RegExp | undefined;
  /**
   * The inverse of the last applied replace, fenced on the texts it
   * produced; consumed by one undo.
   */
  private pendingUndo:
    | { edits: WorkspaceTextEdit[]; expectedSourceHashes: Record<string, string> }
    | undefined;

  constructor(
    private readonly _logger: LogProvider,
    private readonly _fsal: Pick<
      FSAL,
      | "readDirectoryRecursively"
      | "isFile"
      | "getDescriptorForAnySupportedFile"
      | "loadAnySupportedFile"
    >,
    private readonly _config: {
      get: () => { app: Pick<ConfigOptions["app"], "openWorkspaces" | "openFiles"> };
    },
    /** The document authority: open Markdown buffers are searched and replaced through it. */
    private readonly _documents: WorkspaceEditAuthority & Pick<DocumentManager, "saveFile">,
    /** Where the workspace-edit transaction keeps its journal. */
    private readonly _journalDirectory: string,
  ) {
    this.currentSearch = undefined;
    this.fileSearchQueue = [];
    this.sumFilesToSearch = 0;
    this.searchGeneration = 0;
    this.lastPattern = undefined;
    this.pendingUndo = undefined;

    ipcMain.handle("search-provider", async (_event, message: SearchProviderIPCAPI) => {
      const { command, payload } = message;

      if (command === "start-full-text-search") {
        return await this.startSearch(payload.query);
      } else if (command === "cancel-search") {
        this.cancelSearch();
        this.searchGeneration++;
        broadcastIPCMessage("search-provider", {
          type: "search-end",
          generation: this.searchGeneration,
        } satisfies SearchProviderBroadcast);
      } else if (command === "replace-in-files") {
        return await this.replaceInFiles(
          payload.targets,
          payload.replacement,
          payload.preserveCase,
        );
      } else if (command === "undo-last-replace") {
        return await this.undoLastReplace();
      }
    });
  }

  async boot(): Promise<void> {}

  async shutdown(): Promise<void> {}

  /**
   * The text a search sees and a replace changes: the authority's buffer for
   * an open Markdown document, the file on disk otherwise.
   */
  private async readSource(absPath: string): Promise<string> {
    const buffer = this._documents.readMarkdownBufferContent(absPath);
    if (buffer !== undefined) {
      return buffer;
    }
    return await this._fsal.loadAnySupportedFile(absPath);
  }

  /**
   * What a search has of one file. An open Markdown document has the text of
   * its buffer, also when its file cannot be read.
   */
  private async searchSource(absPath: string): Promise<SearchSource> {
    const buffer = this._documents.readMarkdownBufferContent(absPath);
    if (buffer !== undefined) {
      return { kind: "text", source: buffer, replaceable: true };
    }
    return await this._fsal
      .getDescriptorForAnySupportedFile(absPath)
      .then(async (descriptor): Promise<SearchSource> => {
        if (descriptor.type === "other") {
          return { kind: "no-text" };
        }
        if (descriptor.readError !== undefined) {
          return { kind: "not-searched", cause: descriptor.readError.message };
        }
        return {
          kind: "text",
          source: await this._fsal.loadAnySupportedFile(absPath),
          replaceable: descriptor.type === "file",
        };
      })
      .catch((error: unknown): SearchSource => {
        // The filesystem refused the file between the listing and the read.
        if (!isErrnoException(error)) {
          throw error;
        }
        return { kind: "not-searched", cause: error.message };
      });
  }

  private cancelSearch(): void {
    // Letting the running read finish and dropping the queue is enough: the
    // generation on the next start is what silences anything still in flight.
    this.currentSearch = undefined;
    this.fileSearchQueue = [];
    this.sumFilesToSearch = 0;
  }

  /**
   * Starts a search. An empty query searches nothing and says so by ending
   * immediately, which is what an empty field means; an expression the
   * engine refused is reported as the failure it is.
   *
   * @param   {SearchQuery}  query  The query the widget holds
   *
   * @return  {Promise<number>}     How many files will be read
   */
  private async startSearch(query: SearchQuery): Promise<number> {
    this.cancelSearch();
    const generation = ++this.searchGeneration;
    const compiled = compileQuery(query);
    if (compiled.status === "empty") {
      broadcastIPCMessage("search-provider", {
        type: "search-end",
        generation,
      } satisfies SearchProviderBroadcast);
      return 0;
    }
    if (compiled.status === "invalid-regex") {
      broadcastIPCMessage("search-provider", {
        type: "search-failed",
        generation,
        failure: { kind: "invalid-query", message: compiled.message },
      } satisfies SearchProviderBroadcast);
      return 0;
    }

    const files = await this.filesToSearch(query, () => generation === this.searchGeneration);
    if (files === undefined) {
      return 0; // A newer request took ownership while this one enumerated the workspaces.
    }
    for (const folder of files.notListed) {
      broadcastIPCMessage("search-provider", {
        type: "search-unread",
        generation,
        file: folder,
        progress: 0,
      } satisfies SearchProviderBroadcast);
    }
    this.fileSearchQueue = files.queue;
    this.currentSearch = { pattern: compiled.pattern, generation };
    this.lastPattern = compiled.pattern;
    this.sumFilesToSearch = this.fileSearchQueue.length;

    this.searchNextFile();
    return this.sumFilesToSearch;
  }

  /**
   * Runs a query to completion and returns every file's matches at once, for
   * a caller that cannot listen to the view's broadcasts (the agent API).
   * The files, the matching and the previews are the Search view's. Matching
   * one file runs under a deadline, because the pattern comes from outside
   * the app and a catastrophic regular expression would otherwise stall the
   * main process. The search stops at maxMatches matches and says so. A
   * file that the filesystem refuses to read, and a folder that it refuses
   * to list, is in `notSearched`.
   */
  public async searchWorkspace(
    query: SearchQuery,
    maxMatches: number,
    fileDeadlineMs: number,
  ): Promise<WorkspaceSearchOutcome> {
    const compiled = compileQuery(query);
    if (compiled.status === "empty") {
      return { status: "invalid-query", message: "The search text is empty" };
    }
    if (compiled.status === "invalid-regex") {
      return { status: "invalid-query", message: compiled.message };
    }

    const files = await this.filesToSearch(query, () => true);
    if (files === undefined) {
      throw new Error("[Search Provider] A workspace search without a generation was superseded");
    }
    const results: FileSearchResult[] = [];
    const notSearched: UnsearchedFile[] = [...files.notListed];
    let matchCount = 0;
    for (const absPath of files.queue) {
      const read = await this.searchSource(absPath);
      if (read.kind === "no-text") {
        continue;
      }
      if (read.kind === "not-searched") {
        notSearched.push({ documentPath: absPath, kind: "file", cause: read.cause });
        continue;
      }
      const { source, replaceable } = read;
      let matches: SearchMatch[];
      try {
        // The same watchdog the single-document agent search runs under:
        // Node interrupts the script, and the regular expression inside it,
        // once the timeout passes.
        matches = vm.runInNewContext(
          "matchDocument(source, pattern)",
          { matchDocument, source, pattern: compiled.pattern },
          { timeout: fileDeadlineMs },
        ) as SearchMatch[];
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
          return { status: "timeout", documentPath: absPath };
        }
        throw err;
      }
      if (matches.length === 0) {
        continue;
      }
      const kept = matches.slice(0, maxMatches - matchCount);
      results.push({
        documentPath: absPath,
        sourceHash: hashDocumentSource(source),
        replaceable,
        matches: kept,
      });
      matchCount += kept.length;
      if (kept.length < matches.length) {
        return { status: "ok", results, matchCount, truncated: true, notSearched };
      }
    }
    return { status: "ok", results, matchCount, truncated: false, notSearched };
  }

  /**
   * The files a query admits, in workspace order and without duplicates:
   * every file under the open workspaces, then the open files, filtered by
   * the query's globs; and each folder of the workspaces whose content the
   * filesystem refused. Undefined when isCurrent reports that a newer search
   * took over while the workspaces were walked.
   */
  private async filesToSearch(
    query: SearchQuery,
    isCurrent: () => boolean,
  ): Promise<{ queue: string[]; notListed: UnsearchedFile[] } | undefined> {
    const { openWorkspaces, openFiles } = this._config.get().app;
    const roots = [...openWorkspaces];
    const listings = await Promise.all(
      roots.map(async (root) => await this._fsal.readDirectoryRecursively(root)),
    );
    if (!isCurrent()) {
      return undefined;
    }
    const candidates = listings.flatMap((listing) => listing.paths);
    const notListed = listings.flatMap((listing) =>
      listing.notListed.map(
        (folder): UnsearchedFile => ({
          documentPath: folder.path,
          kind: "folder",
          cause: folder.cause,
        }),
      ),
    );
    const includesPath = compilePathFilter(query.include, query.exclude);
    const queue: string[] = [];

    for (const candidate of candidates.concat(openFiles)) {
      if (!includesPath(this.relativePath(candidate, roots))) {
        continue;
      }
      const candidateIsFile = await this._fsal.isFile(candidate);
      if (!isCurrent()) {
        return undefined;
      }
      if (candidateIsFile && !queue.includes(candidate)) {
        queue.push(candidate);
      }
    }
    return { queue, notListed };
  }

  /**
   * The path a glob is matched against: relative to the innermost workspace
   * root that holds the file, so `foundations/*.md` means what it says. A file outside
   * every root is matched by its own name.
   */
  private relativePath(absPath: string, roots: string[]): string {
    const root = innermostRoot(absPath, roots);
    const relative = root === undefined ? path.basename(absPath) : path.relative(root, absPath);
    return relative.split(path.sep).join("/");
  }

  /** Reads the next file in the queue, reports it, and moves on. */
  private searchNextFile(): void {
    const search = this.currentSearch;
    const nextFile = this.fileSearchQueue.shift();
    if (search === undefined) {
      // Nothing is running: the queue was cancelled between two files.
      broadcastIPCMessage("search-provider", {
        type: "search-end",
        generation: this.searchGeneration,
      } satisfies SearchProviderBroadcast);
      return;
    }
    if (nextFile === undefined) {
      this.currentSearch = undefined;
      broadcastIPCMessage("search-provider", {
        type: "search-end",
        generation: search.generation,
      } satisfies SearchProviderBroadcast);
      return;
    }

    this.searchFile(nextFile, search.pattern)
      .then((outcome) => {
        if (this.currentSearch?.generation !== search.generation) {
          return; // A newer search started; this belongs to the old query.
        }
        const progress =
          (this.sumFilesToSearch - this.fileSearchQueue.length) / this.sumFilesToSearch;
        if (outcome.kind === "no-matches") {
          broadcastIPCMessage("search-provider", {
            type: "search-progress",
            generation: search.generation,
            progress,
          } satisfies SearchProviderBroadcast);
        } else if (outcome.kind === "not-searched") {
          broadcastIPCMessage("search-provider", {
            type: "search-unread",
            generation: search.generation,
            file: outcome.file,
            progress,
          } satisfies SearchProviderBroadcast);
        } else {
          broadcastIPCMessage("search-provider", {
            type: "search-result",
            generation: search.generation,
            result: outcome.result,
            progress,
          } satisfies SearchProviderBroadcast);
        }
      })
      .catch((err) => {
        if (this.currentSearch?.generation !== search.generation) {
          return; // A newer search started; this belongs to the old query.
        }
        // No filesystem error: the search of this file failed in the app.
        // Stop, and say at which file.
        this._logger.error(
          `[Search Provider] Could not search file ${nextFile}: ${String(err)}`,
          err,
        );
        this.cancelSearch();
        broadcastIPCMessage("search-provider", {
          type: "search-failed",
          generation: search.generation,
          failure: { kind: "stopped", documentPath: nextFile, message: String(err) },
        } satisfies SearchProviderBroadcast);
      })
      .finally(() => {
        this.searchNextFile();
      });
  }

  /** The matches of one file, or the cause when the search did not read it. */
  private async searchFile(absPath: string, pattern: RegExp): Promise<FileSearchOutcome> {
    const read = await this.searchSource(absPath);
    if (read.kind === "no-text") {
      return { kind: "no-matches" };
    }
    if (read.kind === "not-searched") {
      return {
        kind: "not-searched",
        file: { documentPath: absPath, kind: "file", cause: read.cause },
      };
    }
    const matches = matchDocument(read.source, pattern);
    if (matches.length === 0) {
      return { kind: "no-matches" };
    }
    return {
      kind: "matches",
      result: {
        documentPath: absPath,
        sourceHash: hashDocumentSource(read.source),
        replaceable: read.replaceable,
        matches,
      },
    };
  }

  /**
   * Replaces the given spans through the journaled workspace-edit
   * transaction: every document is re-read and hash-checked before anything
   * changes, open buffers change through the authority, closed files on disk,
   * and the inverse is kept for one undo. Only Markdown documents are
   * replaced in: an open code document is outside the authority's contract.
   */
  private async replaceInFiles(
    targets: ReplaceTarget[],
    replacement: string,
    preserveCase: boolean,
  ): Promise<ReplaceOutcome> {
    const pattern = this.lastPattern;
    if (pattern === undefined) {
      throw new Error("[Search Provider] Cannot replace before a search has run");
    }

    const edits: WorkspaceTextEdit[] = [];
    const inverse: WorkspaceTextEdit[] = [];
    const expectedSourceHashes: Record<string, string> = {};
    for (const target of targets) {
      const descriptor = await this._fsal.getDescriptorForAnySupportedFile(target.documentPath);
      if (descriptor.type !== "file") {
        throw new Error(
          `[Search Provider] Replace addresses ${target.documentPath}, which is not a Markdown document`,
        );
      }
      const source = await this.readSource(target.documentPath);
      if (hashDocumentSource(source) !== target.sourceHash) {
        return { status: "conflict", documentPath: target.documentPath };
      }

      // Each edit is expressed in the source's own offsets; the inverse has
      // to be expressed in the offsets the replace produces, so it carries
      // the length the replacements ahead of it added or took away.
      let shift = 0;
      for (const range of [...target.ranges].sort((a, b) => a.from - b.from)) {
        const matched = source.slice(range.from, range.to);
        const insert = expandReplacement(matched, pattern, replacement, preserveCase);
        edits.push({ documentPath: target.documentPath, range, insert });
        inverse.push({
          documentPath: target.documentPath,
          range: { from: range.from + shift, to: range.from + shift + insert.length },
          insert: matched,
        });
        shift += insert.length - (range.to - range.from);
      }
      expectedSourceHashes[target.documentPath] = target.sourceHash;
    }

    const result = await runWorkspaceEditTransaction(this._documents, this._journalDirectory, {
      edits,
      expectedSourceHashes,
    });
    if (result.status === "conflict") {
      return { status: "conflict", documentPath: result.documentPath };
    }
    await saveUpdatedBuffers(
      async (documentPath) => await this._documents.saveFile(documentPath),
      result.openBuffersUpdated,
    );
    this.pendingUndo = { edits: inverse, expectedSourceHashes: result.resultingHashes };
    return {
      status: "applied",
      documentsChanged: [...result.openBuffersUpdated, ...result.closedFilesWritten],
      matchesReplaced: edits.length,
    };
  }

  /** Applies the last replace's inverse through the same transaction, once. */
  private async undoLastReplace(): Promise<UndoReplaceOutcome> {
    const pending = this.pendingUndo;
    if (pending === undefined) {
      return { status: "nothing-to-undo" };
    }
    const result = await runWorkspaceEditTransaction(
      this._documents,
      this._journalDirectory,
      pending,
    );
    if (result.status === "conflict") {
      return { status: "conflict", documentPath: result.documentPath };
    }
    await saveUpdatedBuffers(
      async (documentPath) => await this._documents.saveFile(documentPath),
      result.openBuffersUpdated,
    );
    this.pendingUndo = undefined;
    return {
      status: "applied",
      documentsChanged: [...result.openBuffersUpdated, ...result.closedFilesWritten],
      matchesReplaced: pending.edits.length,
    };
  }
}

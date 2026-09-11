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
 *                  the reference rename owns.
 *
 * END HEADER
 */

import type LogProvider from '../log'
import type ProviderContract from '../provider-contract'
import { ipcMain } from 'electron'
import type { IPCMessage } from '../provider-contract'
import {
  compileQuery,
  expandReplacement,
  matchDocument,
  type SearchMatch,
  type SearchQuery
} from './util/search-query'
import { compilePathFilter } from './util/search-globs'
import type FSAL from '../fsal'
import broadcastIPCMessage from 'source/common/util/broadcast-ipc-message'
import type ConfigProvider from '../config'
import type DocumentManager from '../documents'
import path from 'path'
import { hashDocumentSource } from '@common/pandoc-util/extract-references'
import type { WorkspaceTextEdit } from '@dts/common/references'
import { runWorkspaceEditTransaction } from '../references/workspace-edit-transaction'

export type { SearchMatch, SearchQuery } from './util/search-query'

/** One file's matches, as the view lists them. */
export interface FileSearchResult {
  documentPath: string
  /** The hash of the text the matches were found in; a replace is fenced on it. */
  sourceHash: string
  /** Whether a replace may address this file: only Markdown documents. */
  replaceable: boolean
  matches: SearchMatch[]
}

/**
 * One document's matches to replace: the spans as the search reported them
 * and the hash of the text they were found in, which the replace is fenced
 * on — a document that changed since the search is refused, not guessed at.
 */
export interface ReplaceTarget {
  documentPath: string
  sourceHash: string
  ranges: Array<{ from: number, to: number }>
}

export type ReplaceOutcome =
  | { status: 'applied', documentsChanged: string[], matchesReplaced: number }
  | { status: 'conflict', documentPath: string }

export type UndoReplaceOutcome = ReplaceOutcome | { status: 'nothing-to-undo' }

export type SearchProviderIPCContract = {
  'start-full-text-search': {
    request: { payload: { query: SearchQuery } }
    response: number
  }
  'cancel-search': {
    request: { payload?: undefined }
    response: undefined
  }
  'replace-in-files': {
    request: { payload: { targets: ReplaceTarget[], replacement: string, preserveCase: boolean } }
    response: ReplaceOutcome
  }
  'undo-last-replace': {
    request: { payload?: undefined }
    response: UndoReplaceOutcome
  }
}

export type SearchProviderIPCAPI = IPCMessage<SearchProviderIPCContract>

/**
 * The messages this provider broadcasts on the 'search-provider' channel
 * while a search runs. The provider is the single owner of this type; the
 * Search view imports it to type its listener.
 */
/**
 * Why a search could not run, or could not finish the files it queued. The
 * view reads these out where it would otherwise read out a result count, so
 * a search that read fewer files than it queued never counts as a search
 * that found nothing.
 */
export type SearchFailure =
  | { kind: 'invalid-query', message: string }
  | { kind: 'unreadable-file', documentPath: string, message: string }

export type SearchProviderBroadcast =
  | { type: 'search-end', generation: number }
  | { type: 'search-result', generation: number, result: FileSearchResult, progress: number }
  | { type: 'search-progress', generation: number, progress: number }
  | { type: 'search-failed', generation: number, failure: SearchFailure }

export class SearchProvider implements ProviderContract {
  /** How many files this search will read, for the progress it reports. */
  private sumFilesToSearch: number
  /** The absolute paths still to read. */
  private fileSearchQueue: string[]
  /** The search running now, or undefined between searches. */
  private currentSearch: { pattern: RegExp, generation: number }|undefined
  /**
   * Every search gets a number, and a result carrying a stale one is
   * dropped: a query typed one character at a time starts a search per
   * character, and the one still arriving from two characters ago must not
   * reach the view.
   */
  private searchGeneration: number
  /** The query the last search ran with; a replace expands against its pattern. */
  private lastPattern: RegExp|undefined
  /**
   * The inverse of the last applied replace, fenced on the texts it
   * produced; consumed by one undo.
   */
  private pendingUndo: { edits: WorkspaceTextEdit[], expectedSourceHashes: Record<string, string> }|undefined

  constructor (
    private readonly _logger: LogProvider,
    private readonly _fsal: FSAL,
    private readonly _config: ConfigProvider,
    /** The document authority: open Markdown buffers are searched and replaced through it. */
    private readonly _documents: DocumentManager,
    /** Where the workspace-edit transaction keeps its journal. */
    private readonly _journalDirectory: string
  ) {
    this.currentSearch = undefined
    this.fileSearchQueue = []
    this.sumFilesToSearch = 0
    this.searchGeneration = 0
    this.lastPattern = undefined
    this.pendingUndo = undefined

    ipcMain.handle('search-provider', async (_event, message: SearchProviderIPCAPI) => {
      const { command, payload } = message

      if (command === 'start-full-text-search') {
        return await this.startSearch(payload.query)
      } else if (command === 'cancel-search') {
        this.cancelSearch()
      } else if (command === 'replace-in-files') {
        return await this.replaceInFiles(payload.targets, payload.replacement, payload.preserveCase)
      } else if (command === 'undo-last-replace') {
        return await this.undoLastReplace()
      }
    })
  }

  async boot (): Promise<void> {}

  async shutdown (): Promise<void> {}

  /**
   * The text a search sees and a replace changes: the authority's buffer for
   * an open Markdown document, the file on disk otherwise.
   */
  private async readSource (absPath: string): Promise<string> {
    const buffer = this._documents.readMarkdownBufferContent(absPath)
    if (buffer !== undefined) {
      return buffer
    }
    return await this._fsal.loadAnySupportedFile(absPath)
  }

  private cancelSearch (): void {
    // Letting the running read finish and dropping the queue is enough: the
    // generation on the next start is what silences anything still in flight.
    this.currentSearch = undefined
    this.fileSearchQueue = []
    this.sumFilesToSearch = 0
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
  private async startSearch (query: SearchQuery): Promise<number> {
    this.cancelSearch()
    const compiled = compileQuery(query)
    if (compiled.status === 'empty') {
      this.searchGeneration++
      broadcastIPCMessage('search-provider', { type: 'search-end', generation: this.searchGeneration } satisfies SearchProviderBroadcast)
      return 0
    }
    if (compiled.status === 'invalid-regex') {
      this.searchGeneration++
      broadcastIPCMessage('search-provider', {
        type: 'search-failed',
        generation: this.searchGeneration,
        failure: { kind: 'invalid-query', message: compiled.message }
      } satisfies SearchProviderBroadcast)
      return 0
    }

    const { openWorkspaces, openFiles } = this._config.get().app
    const roots = [...openWorkspaces]
    const candidates = (await Promise.all(roots.map(async root => await this._fsal.readDirectoryRecursively(root)))).flat()
    const includesPath = compilePathFilter(query.include, query.exclude)

    for (const candidate of candidates.concat(openFiles)) {
      if (!includesPath(this.relativePath(candidate, roots))) {
        continue
      }
      if (await this._fsal.isFile(candidate) && !this.fileSearchQueue.includes(candidate)) {
        this.fileSearchQueue.push(candidate)
      }
    }

    this.searchGeneration++
    this.currentSearch = { pattern: compiled.pattern, generation: this.searchGeneration }
    this.lastPattern = compiled.pattern
    this.sumFilesToSearch = this.fileSearchQueue.length

    this.searchNextFile()
    return this.sumFilesToSearch
  }

  /**
   * The path a glob is matched against: relative to the workspace root that
   * holds the file, so `foundations/*.md` means what it says. A file outside
   * every root is matched by its own name.
   */
  private relativePath (absPath: string, roots: string[]): string {
    const root = roots.find(candidate => absPath.startsWith(`${candidate}${path.sep}`))
    const relative = root === undefined ? path.basename(absPath) : path.relative(root, absPath)
    return relative.split(path.sep).join('/')
  }

  /** Reads the next file in the queue, reports it, and moves on. */
  private searchNextFile (): void {
    const search = this.currentSearch
    const nextFile = this.fileSearchQueue.shift()
    if (search === undefined || nextFile === undefined) {
      if (search !== undefined) {
        this.currentSearch = undefined
      }
      broadcastIPCMessage('search-provider', { type: 'search-end', generation: search?.generation ?? this.searchGeneration } satisfies SearchProviderBroadcast)
      return
    }

    this.searchFile(nextFile, search.pattern)
      .then(result => {
        if (this.currentSearch?.generation !== search.generation) {
          return // A newer search started; this belongs to the old query.
        }
        const progress = (this.sumFilesToSearch - this.fileSearchQueue.length) / this.sumFilesToSearch
        if (result === undefined) {
          broadcastIPCMessage('search-provider', { type: 'search-progress', generation: search.generation, progress } satisfies SearchProviderBroadcast)
        } else {
          broadcastIPCMessage('search-provider', { type: 'search-result', generation: search.generation, result, progress } satisfies SearchProviderBroadcast)
        }
      })
      .catch(err => {
        if (this.currentSearch?.generation !== search.generation) {
          return // A newer search started; this belongs to the old query.
        }
        // A file that was queued and then could not be read means the result
        // list no longer describes the workspace. Stop, and say which file:
        // carrying on would report a count over the files that happened to
        // be readable.
        this._logger.error(`[Search Provider] Could not search file ${nextFile}: ${String(err)}`, err)
        this.cancelSearch()
        broadcastIPCMessage('search-provider', {
          type: 'search-failed',
          generation: search.generation,
          failure: { kind: 'unreadable-file', documentPath: nextFile, message: String(err) }
        } satisfies SearchProviderBroadcast)
      })
      .finally(() => {
        this.searchNextFile()
      })
  }

  /** One file's matches, or undefined when it has none. */
  private async searchFile (absPath: string, pattern: RegExp): Promise<FileSearchResult|undefined> {
    const descriptor = await this._fsal.getDescriptorForAnySupportedFile(absPath)
    if (descriptor.type === 'other') {
      return undefined
    }

    const source = await this.readSource(absPath)
    const matches = matchDocument(source, pattern)
    if (matches.length === 0) {
      return undefined
    }

    return {
      documentPath: absPath,
      sourceHash: hashDocumentSource(source),
      replaceable: descriptor.type === 'file',
      matches
    }
  }

  /**
   * Replaces the given spans through the journaled workspace-edit
   * transaction: every document is re-read and hash-checked before anything
   * changes, open buffers change through the authority, closed files on disk,
   * and the inverse is kept for one undo. Only Markdown documents are
   * replaced in: an open code document is outside the authority's contract.
   */
  private async replaceInFiles (targets: ReplaceTarget[], replacement: string, preserveCase: boolean): Promise<ReplaceOutcome> {
    const pattern = this.lastPattern
    if (pattern === undefined) {
      throw new Error('[Search Provider] Cannot replace before a search has run')
    }

    const edits: WorkspaceTextEdit[] = []
    const inverse: WorkspaceTextEdit[] = []
    const expectedSourceHashes: Record<string, string> = {}
    for (const target of targets) {
      const descriptor = await this._fsal.getDescriptorForAnySupportedFile(target.documentPath)
      if (descriptor.type !== 'file') {
        throw new Error(`[Search Provider] Replace addresses ${target.documentPath}, which is not a Markdown document`)
      }
      const source = await this.readSource(target.documentPath)
      if (hashDocumentSource(source) !== target.sourceHash) {
        return { status: 'conflict', documentPath: target.documentPath }
      }

      // Each edit is expressed in the source's own offsets; the inverse has
      // to be expressed in the offsets the replace produces, so it carries
      // the length the replacements ahead of it added or took away.
      let shift = 0
      for (const range of [...target.ranges].sort((a, b) => a.from - b.from)) {
        const matched = source.slice(range.from, range.to)
        const insert = expandReplacement(matched, pattern, replacement, preserveCase)
        edits.push({ documentPath: target.documentPath, range, insert })
        inverse.push({
          documentPath: target.documentPath,
          range: { from: range.from + shift, to: range.from + shift + insert.length },
          insert: matched
        })
        shift += insert.length - (range.to - range.from)
      }
      expectedSourceHashes[target.documentPath] = target.sourceHash
    }

    const result = await runWorkspaceEditTransaction(this._documents, this._journalDirectory, { edits, expectedSourceHashes })
    if (result.status === 'conflict') {
      return { status: 'conflict', documentPath: result.documentPath }
    }
    await this.saveUpdatedBuffers(result.openBuffersUpdated)
    this.pendingUndo = { edits: inverse, expectedSourceHashes: result.resultingHashes }
    return {
      status: 'applied',
      documentsChanged: [ ...result.openBuffersUpdated, ...result.closedFilesWritten ],
      matchesReplaced: edits.length
    }
  }

  /** Applies the last replace's inverse through the same transaction, once. */
  private async undoLastReplace (): Promise<UndoReplaceOutcome> {
    const pending = this.pendingUndo
    if (pending === undefined) {
      return { status: 'nothing-to-undo' }
    }
    const result = await runWorkspaceEditTransaction(this._documents, this._journalDirectory, pending)
    if (result.status === 'conflict') {
      return { status: 'conflict', documentPath: result.documentPath }
    }
    await this.saveUpdatedBuffers(result.openBuffersUpdated)
    this.pendingUndo = undefined
    return {
      status: 'applied',
      documentsChanged: [ ...result.openBuffersUpdated, ...result.closedFilesWritten ],
      matchesReplaced: pending.edits.length
    }
  }

  /**
   * A replace ends on disk for every document it touched: closed files are
   * written by the transaction, open buffers are saved here (VS Code's
   * Replace All saves the edited files the same way).
   */
  private async saveUpdatedBuffers (documentPaths: string[]): Promise<void> {
    for (const documentPath of documentPaths) {
      const saved = await this._documents.saveFile(documentPath)
      if (!saved.ok) {
        throw new Error(`[Search Provider] Could not save ${documentPath} after the replace: ${saved.refusal?.message ?? 'no refusal reason'}`)
      }
    }
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SearchProvider
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file defines a search provider that allows finding
 *                  things across the loaded workspaces.
 *
 * END HEADER
 */

import type LogProvider from '../log'
import type ProviderContract from '../provider-contract'
import { ipcMain } from 'electron'
import type { IPCMessage } from '../provider-contract'
import { compileBooleanQuery, searchFileBoolean, type SearchResult, type SearchQueryBoolean } from './util/boolean-search'
import type FSAL from '../fsal'
import broadcastIPCMessage from 'source/common/util/broadcast-ipc-message'
import type ConfigProvider from '../config'
import type DocumentManager from '../documents'
import path from 'path'
import { hashDocumentSource } from '@common/pandoc-util/extract-references'
import type { WorkspaceTextEdit } from '@dts/common/references'
import { runWorkspaceEditTransaction } from '../references/workspace-edit-transaction'
import { planDocumentReplace } from './util/replace-plan'

export { SearchResult, FileContentSearchResult } from './util/boolean-search'

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
    request: { payload: { query: string, restrictToDirectory: string, caseInsensitive: boolean } }
    response: number
  }
  'cancel-search': {
    request: { payload?: undefined }
    response: undefined
  }
  'replace-in-files': {
    request: { payload: { targets: ReplaceTarget[], replacement: string } }
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
 * while a full-text search runs. The provider is the single owner of this
 * type; the renderer's search UI imports it to type its listener.
 */
export type SearchProviderBroadcast =
  | { type: 'search-end' }
  | { type: 'search-result', file: string, result: SearchResult|undefined, sourceHash: string, progress: number }

export class SearchProvider implements ProviderContract {
  /**
   * Keeps a count of all files that will be searched during a search-in-
   * progress. Used to calculate an overall progress.
   *
   * @var {number}
   */
  private sumFilesToSearch: number
  /**
   * Contains the absolute paths of all files that will be searched during the
   * ongoing search.
   *
   * @var {string[]}
   */
  private fileSearchQueue: string[]
  /**
   * Contains the current search query.
   *
   * @var {SearchQueryBoolean|undefined}
   */
  private currentQuery: SearchQueryBoolean|undefined
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
    this.currentQuery = undefined
    this.fileSearchQueue = []
    this.sumFilesToSearch = 0
    this.pendingUndo = undefined

    ipcMain.handle('search-provider', async (event, message: SearchProviderIPCAPI) => {
      const { command, payload } = message

      if (command === 'start-full-text-search') {
        return await this.startFullTextSearch(
          payload.query, payload.restrictToDirectory, payload.caseInsensitive
        )
      } else if (command === 'cancel-search') {
        // By simply removing all remaining files, we can let the search agent
        // finish its current search and then just stop (& emit the correct
        // events).
        this.currentQuery = undefined
        this.fileSearchQueue = []
        this.sumFilesToSearch = 0
      } else if (command === 'replace-in-files') {
        return await this.replaceInFiles(payload.targets, payload.replacement)
      } else if (command === 'undo-last-replace') {
        return await this.undoLastReplace()
      }
    })
  }

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

  /**
   * Replaces the given spans through the journaled workspace-edit
   * transaction: every document is re-read and hash-checked before anything
   * changes, open buffers change through the authority, closed files on disk,
   * and the inverse is kept for one undo. Only Markdown documents are
   * replaced in: an open code document is outside the authority's contract.
   */
  private async replaceInFiles (targets: ReplaceTarget[], replacement: string): Promise<ReplaceOutcome> {
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
      const plan = planDocumentReplace(target.documentPath, source, target.ranges, replacement)
      edits.push(...plan.edits)
      inverse.push(...plan.inverse)
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

  async boot () {}

  async shutdown () {}

  /**
   * Begins a new full-text search
   *
   * @param   {string}   query                The query to search for
   * @param   {string}   restrictToDirectory  If provided, restricts the search to the provided directory
   * @param   {boolean}  caseInsensitive      Whether to perform a case insensitive search
   * @param   {string}   type                 The type of search. Currently unused.
   *
   * @return  {number}                        The number of files that will be searched.
   */
  private async startFullTextSearch (query: string, restrictToDirectory: string, caseInsensitive: boolean, type: 'boolean' = 'boolean'): Promise<number> {
    if (type !== 'boolean') {
      throw new Error(`Cannot start search: Type ${type} unrecognized.`)
    }

    this.currentQuery = compileBooleanQuery(query, caseInsensitive)
    if (restrictToDirectory.trim() === '') {
      // The user wants to search all workspaces and files
      const { openWorkspaces, openFiles } = this._config.get().app

      // First, await all paths within all our workspaces to generate a list of
      // files recursively.
      const promises = openWorkspaces.map(ws => this._fsal.readDirectoryRecursively(ws))
      const workspacePaths = (await Promise.all(promises)).flat()

      // Then, use that list plus all open files to create a file search queue.
      const allPaths = workspacePaths.concat(openFiles)

      for (const p of allPaths) {
        if (await this._fsal.isFile(p)) {
          this.fileSearchQueue.push(p)
        }
      }
    } else {
      // The user only wants to search a single directory.
      this.fileSearchQueue = await this._fsal.readDirectoryRecursively(restrictToDirectory)
    }

    this.sumFilesToSearch = this.fileSearchQueue.length

    // Start the search
    this.searchNextFile()
    
    // Return the number of files to search
    return this.fileSearchQueue.length
  }

  /**
   * Runs a single search using the next available file to search
   */
  private searchNextFile () {
    const nextFile = this.fileSearchQueue.shift()
    if (nextFile === undefined || this.currentQuery === undefined) {
      broadcastIPCMessage('search-provider', { type: 'search-end' })
      this.currentQuery = undefined
      return
    }

    this.searchFileBoolean(nextFile, this.currentQuery)
      .then(({ result: rawResult, sourceHash }) => {
        // Save some resources both in the IPC and the renderer by not
        // reporting empty results. We do so by setting the result as undefined.
        const result = rawResult.length > 0 ? rawResult : undefined
        const total = this.sumFilesToSearch
        const remaining = this.fileSearchQueue.length
        const progress = (total - remaining) / total
        broadcastIPCMessage('search-provider', { type: 'search-result', file: nextFile, result, sourceHash, progress })
      })
      .catch(err => {
        this._logger.error(`[Search Provider] Could not search file ${nextFile}: ${err}`, err)
      })
      .finally(() => {
        // Do the next search
        this.searchNextFile()
      })
  }

  /**
   * Searches a file using a boolean search query
   *
   * @param   {string}              absPath  The file path
   * @param   {SearchQueryBoolean}  query    The query
   *
   * @return  {SearchResult}                 The search result
   */
  private async searchFileBoolean (absPath: string, query: SearchQueryBoolean): Promise<{ result: SearchResult, sourceHash: string }> {
    const descriptor = await this._fsal.getDescriptorForAnySupportedFile(absPath)
    if (descriptor.type === 'other') {
      return { result: [], sourceHash: '' }
    }

    this._logger.verbose(`[Search Provider] Searching file ${path.basename(absPath)}...`)

    const fileContent = await this.readSource(absPath)
    return { result: searchFileBoolean(descriptor, fileContent, query), sourceHash: hashDocumentSource(fileContent) }
  }
}

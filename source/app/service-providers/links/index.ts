/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LinkProvider class
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Handles links back and forth
 *
 * END HEADER
 */

import { ipcMain } from 'electron'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import { splitWikilinkTarget, WikilinkIndex, type WikilinkResolution } from '@common/util/wikilink-resolution'
import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import path from 'path'
import type FSAL from '../fsal'
import type ConfigProvider from '../config'
import type { MDFileDescriptor } from 'source/types/common/fsal'
import type { WikilinkEdge } from './ipc-contract'
import { movedPath, retargetedLink, retargetLinks, type PathMove } from '@common/util/replace-links'

/** The wikilinks of every file and the index they resolve against. */
export interface WikilinkSnapshot {
  index: WikilinkIndex
  links: Map<string, string[]>
}

/**
 * This class resolves the wikilinks of the loaded workspaces. It keeps the
 * outbound link targets of every file and the workspace's wikilink index, and
 * rebuilds both whenever a workspace changes.
 */
export default class LinkProvider extends ProviderContract {
  private _fileLinkDatabase: Map<string, string[]>
  private _index: WikilinkIndex

  constructor (private readonly _logger: LogProvider, private readonly _config: ConfigProvider, private readonly _fsal: FSAL) {
    super()

    this._fileLinkDatabase = new Map()
    this._index = new WikilinkIndex([])

    ipcMain.handle('link-provider', async (event, message) => {
      const { command } = message

      if (command === 'get-inbound-links') {
        // Return whatever links to the given file
        const filePath: string = message.payload.filePath
        return {
          inbound: this.retrieveInbound(filePath),
          outbound: this.retrieveOutbound(filePath)
        }
      } else if (command === 'get-link-database') {
        return this.linkDatabase()
      } else if (command === 'get-link-targets') {
        return this.linkTargets()
      }
    })
  }

  public async boot (): Promise<void> {
    // Listen to state changes within the Workspaces Provider
    this._fsal.on('fsal-event', () => {
      // Some workspace has changed, so simply pull in the new map
      this.reindex()
        .then(() => broadcastIpcMessage('links'))
        .catch(err => this._logger.error(`[LinkProvider] Could not update the link database: ${err.message}`, err))
    })

    // Pull in the initial update
    await this.reindex()
  }

  /**
   * Reindexes the entire link database.
   */
  public async reindex (): Promise<void> {
    const descriptors = (await this._fsal.getAllLoadedDescriptors())
      .filter((descriptor): descriptor is MDFileDescriptor => descriptor.type === 'file')

    // A file belongs to the innermost open workspace that contains it; a file
    // opened on its own is its own workspace.
    const workspaces = [...this._config.get().app.openWorkspaces]
      .sort((a, b) => b.length - a.length)
    const rootFor = (filePath: string): string => {
      return workspaces.find(root => filePath.startsWith(root + path.sep)) ?? path.dirname(filePath)
    }

    this._fileLinkDatabase = new Map(descriptors.map(descriptor => [ descriptor.path, descriptor.links ]))
    this._index = new WikilinkIndex(descriptors.map(descriptor => ({
      path: descriptor.path,
      root: rootFor(descriptor.path),
      id: descriptor.id,
      title: descriptor.yamlTitle,
      aliases: descriptor.aliases
    })))
  }

  /**
   * Shuts down the service provider
   * @return {Boolean} Returns true after successful shutdown
   */
  async shutdown (): Promise<void> {
    this._logger.verbose('Link provider shutting down ...')
  }

  /**
   * Resolves the target of a wikilink, before its `#` fragment and `|` label,
   * written in the document at `sourcePath`.
   */
  resolve (target: string, sourcePath: string): WikilinkResolution {
    return this._index.resolve(target, sourcePath)
  }

  /** The index as it stands now; a later reindex does not change it. */
  get index (): WikilinkIndex {
    return this._index
  }

  /** The links and the index as they stand now, to retarget after a move. */
  snapshot (): WikilinkSnapshot {
    return { index: this._index, links: this._fileLinkDatabase }
  }

  /**
   * Reindexes after `move`, and returns the files, at their paths before the
   * move, that hold a wikilink whose document the move changed.
   */
  async filesChangedByMove (before: WikilinkSnapshot, move: PathMove): Promise<string[]> {
    await this.reindex()
    return [...before.links].filter(([ sourcePath, links ]) => links.some(link => {
      const { target } = splitWikilinkTarget(link)
      return retargetedLink(target, sourcePath, move, before.index, this._index) !== undefined
    })).map(([sourcePath]) => sourcePath)
  }

  /**
   * Rewrites the wikilinks of `files` (see `filesChangedByMove`) so that each
   * names the document it named before `move`.
   */
  async retargetAfterMove (before: WikilinkSnapshot, move: PathMove, files: string[]): Promise<void> {
    for (const sourcePath of files) {
      const filePath = movedPath(sourcePath, move)
      const content = await this._fsal.readTextFile(filePath)
      const newContent = retargetLinks(content, sourcePath, move, before.index, this._index)
      if (newContent !== content) {
        await this._fsal.writeTextFile(filePath, newContent)
        this._logger.info(`[LinkProvider] Retargeted the wikilinks in ${filePath} after ${move.from} moved to ${move.to}`)
      }
    }
  }

  /** The written form of a wikilink to `filePath`. */
  canonicalTarget (filePath: string): string {
    return this._index.canonical(filePath)
  }

  /** The documents the links in `sourceFilePath` resolve to. */
  private resolvedTargets (sourceFilePath: string): string[] {
    const paths: string[] = []
    for (const link of this._fileLinkDatabase.get(sourceFilePath) ?? []) {
      const resolution = this.resolve(splitWikilinkTarget(link).target, sourceFilePath)
      if (resolution.status === 'resolved' && !paths.includes(resolution.path)) {
        paths.push(resolution.path)
      }
    }
    return paths
  }

  /**
   * Retrieves a set of links to the file given as argument
   *
   * @param   {string}    sourceFilePath  The source file's path
   *
   * @return  {string[]}                  A list of all files linking to sourceFile
   */
  retrieveInbound (sourceFilePath: string): string[] {
    return [...this._fileLinkDatabase.keys()]
      .filter(file => this.resolvedTargets(file).includes(sourceFilePath))
  }

  /**
   * Retrieves a set of files the given source file links to
   *
   * @param   {string}    sourceFilePath  The source file's path
   *
   * @return  {string[]}                  A list of outbound links from source
   */
  retrieveOutbound (sourceFilePath: string): string[] {
    return this.resolvedTargets(sourceFilePath)
  }

  /** Every file's outbound links, each with the document it resolves to. */
  private linkDatabase (): Record<string, WikilinkEdge[]> {
    const database: Record<string, WikilinkEdge[]> = {}
    for (const [ sourcePath, links ] of this._fileLinkDatabase) {
      database[sourcePath] = links.map(link => {
        const { target } = splitWikilinkTarget(link)
        const resolution = this.resolve(target, sourcePath)
        return { target, path: resolution.status === 'resolved' ? resolution.path : undefined }
      })
    }
    return database
  }

  /** The written wikilink form of every file. */
  private linkTargets (): Record<string, string> {
    return Object.fromEntries([...this._fileLinkDatabase.keys()]
      .map(filePath => [ filePath, this.canonicalTarget(filePath) ]))
  }
}

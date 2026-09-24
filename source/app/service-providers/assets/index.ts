/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AssetsProvider
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This provider manages general assets used by the app which
 *                  are not handled by the dictionary or translation provider.
 *
 * END HEADER
 */

import path from 'path'
import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import YAML from 'yaml'
import { FSWatcher } from 'chokidar'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import ProviderContract, { type IPCMessage } from '../provider-contract'
import type LogProvider from '../log'
import type ConfigProvider from '../config'
import { getCustomProfiles } from '@providers/commands/exporter'
import { getAppServiceContainer, isAppServiceContainerReady } from '../../app-service-container'
import { SUPPORTED_READERS } from '@common/pandoc-util/pandoc-maps'
import { parseReaderWriter } from '@common/pandoc-util/parse-reader-writer'
import { isSnippetFileName, parseVSCodeSnippetFile } from '@common/modules/snippets/vscode-snippet-file'
import type { SnippetCatalogue, SnippetFileDiagnostic, UserSnippet } from '@dts/common/snippets'
import type { QuickTexCatalogue } from '@dts/common/quicktex'
import { loadQuickTex } from '../../util/load-quicktex'
import { loadPhraseDictionaries } from '../../util/load-phrase-dictionaries'
import type { PhraseDictionaryEntry } from '@common/util/phrase-dictionary'

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What a parsed YAML document holds under a key. A key the user wrote with the
 * wrong kind of value is its own case: it must never read as an absent key.
 */
type YamlString =
  { kind: 'absent' } |
  { kind: 'string', value: string } |
  { kind: 'malformed', observed: string }

/**
 * Names the kind of value a YAML document holds, for use in a diagnostic.
 */
function describeValue (value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'a list' : `a ${typeof value}`
}

/**
 * Reads a string property off a parsed YAML document.
 */
function stringProperty (doc: Record<string, unknown>, key: string): YamlString {
  const value = doc[key]
  if (value === undefined) {
    return { kind: 'absent' }
  }

  return typeof value === 'string'
    ? { kind: 'string', value }
    : { kind: 'malformed', observed: describeValue(value) }
}

interface PandocProfileBase {
  /**
   * The filename of the defaults file
   */
  name: string
  /**
   * Zettlr ships with a few profiles by default. In order to ensure that there
   * is always a set of minimal profiles to export and import to, Zettlr will
   * ensure that these standard defaults files will always be present. With this
   * flag, renderer elements can additionally indicate that. This helps prevent
   * some misconceptions, i.e. why certain files cannot be deleted.
   */
  isProtected?: boolean
}

/**
 * A profile Zettlr can run. It declares both a reader and a writer, and at
 * least one of the two is a format Zettlr itself speaks. Only this variant may
 * reach the exporter or the importer.
 */
export interface ValidPandocProfile extends PandocProfileBase {
  isInvalid: false
  /**
   * The writer the profile declares, verbatim
   */
  writer: string
  /**
   * The reader the profile declares, verbatim
   */
  reader: string
  /**
   * The Pandoc template the profile declares (resolved by name from the Pandoc
   * data directory), if any. Surfaced for export observability.
   */
  template?: string
}

/**
 * A defaults file Zettlr cannot run. It carries no reader and no writer,
 * because neither could be established; `reason` states what stopped it. The
 * defaults editor still lists these so that the user can repair them.
 */
export interface InvalidPandocProfile extends PandocProfileBase {
  isInvalid: true
  /**
   * What made the profile unusable, as observed while reading the file
   */
  reason: string
}

export type PandocProfileMetadata = ValidPandocProfile|InvalidPandocProfile

export type AssetsProviderIPCContract = {
  'get-filter': {
    request: { payload: { filename: string } }
    response: string
  }
  'set-filter': {
    request: { payload: { filename: string, contents: string } }
    response: boolean
  }
  'rename-filter': {
    request: { payload: { oldName: string, newName: string } }
    response: boolean
  }
  'remove-filter': {
    request: { payload: { filename: string } }
    response: boolean
  }
  'list-filter': {
    request: { payload?: undefined }
    response: string[]
  }
  'list-protected-filter': {
    request: { payload?: undefined }
    response: string[]
  }
  'get-defaults-file': {
    request: { payload: { filename: string } }
    response: string
  }
  'set-defaults-file': {
    request: { payload: { filename: string, contents: string } }
    response: boolean
  }
  'rename-defaults-file': {
    request: { payload: { oldName: string, newName: string } }
    response: boolean
  }
  'remove-defaults-file': {
    request: { payload: { filename: string } }
    response: boolean
  }
  'get-snippets-source': {
    request: { payload?: undefined }
    response: { filePath: string, contents: string }
  }
  'set-snippets-source': {
    request: { payload: { contents: string } }
    response: { ok: true } | { ok: false, error: string }
  }
  'list-defaults': {
    request: { payload?: undefined }
    response: PandocProfileMetadata[]
  }
  'list-export-profiles': {
    request: { payload?: undefined }
    response: PandocProfileMetadata[]
  }
  'list-available-filters': {
    request: { payload?: undefined }
    response: string[]
  }
  // The open-*-directory commands answer with shell.openPath's error string,
  // empty when the directory opened.
  'open-defaults-directory': {
    request: { payload?: undefined }
    response: string
  }
  'open-snippets-file': {
    request: { payload?: undefined }
    response: string
  }
  'open-filter-directory': {
    request: { payload?: undefined }
    response: string
  }
  'list-snippets': {
    request: { payload?: undefined }
    response: SnippetCatalogue
  }
  'get-quicktex': {
    request: { payload?: undefined }
    response: QuickTexCatalogue
  }
  'list-phrase-completions': {
    request: { payload?: undefined }
    response: PhraseDictionaryEntry[]
  }
  'open-phrase-completions-directory': {
    request: { payload?: undefined }
    response: string
  }
}

export type AssetsProviderIPCAPI = IPCMessage<AssetsProviderIPCContract>

export default class AssetsProvider extends ProviderContract {
  /**
   * Holds the path where defaults files can be found.
   *
   * @var {string}
   */
  private readonly _defaultsPath: string
  /**
   * Holds the configured snippets source file.
   *
   * @var {string}
   */
  private readonly _defaultSnippetsFile: string
  private _snippetsFile: string
  private _quickTexFile: string
  private _quickTexCatalogue: QuickTexCatalogue = {
    prose: {},
    math: {},
    excludeChars: ['{', '(', '['],
    sourceFile: '',
    diagnostics: []
  }
  /** Watches the configured snippet and QuickTeX files so external edits update open editors. */
  private readonly _snippetsWatcher: FSWatcher
  /**
   * Holds the path where Lua filters can be found.
   *
   * @var {string}
   */
  private readonly _filterPath: string
  private readonly _phraseCompletionsPath: string
  /**
   * Holds a list of all protected defaults files. Protected defaults files are
   * those that come by default with the app. Protected simply means here that
   * if the user removes such a file, it will be restored immediately. This also
   * applies when the user renames such a file.‚
   *
   * @var {string[]}
   */
  private readonly _protectedDefaults: string[]

  /**
   * Holds a list of all protected filters. Protected filters are those that
   * come by default with the app. Protected here implies the same as for
   * defaults.
   *
   * @var {string[]}
   */
  private readonly _protectedFilters: string[]

  constructor (
    private readonly _logger: LogProvider,
    private readonly _config: ConfigProvider
  ) {
    super()

    this._defaultsPath = path.join(app.getPath('userData'), '/defaults')
    this._defaultSnippetsFile = path.join(app.getPath('home'), '.pandoc', 'snippets', 'snippets.code-snippets')
    this._snippetsFile = ''
    this._quickTexFile = ''
    this._filterPath = path.join(app.getPath('userData'), '/lua-filter')
    this._phraseCompletionsPath = path.join(app.getPath('home'), '.pandoc', 'completions')
    this._protectedDefaults = []
    this._protectedFilters = []
    this._snippetsWatcher = new FSWatcher({
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50
      }
    })

    this._snippetsWatcher.on('all', (_eventName, affectedPath) => {
      const resolved = path.resolve(affectedPath)
      if (this._snippetsFile !== '' && resolved === this._snippetsFile) {
        broadcastIpcMessage('assets-provider', 'snippets-updated')
      }
      if (this._quickTexFile !== '' && resolved === this._quickTexFile) {
        void this.configureQuickTexFile().catch(error => {
          this._logger.error(
            `[Assets Provider] Could not reload QuickTeX after ${this._quickTexFile} changed: ${error instanceof Error ? error.message : String(error)}`,
            error
          )
        })
      }
      if (
        resolved === this._phraseCompletionsPath ||
        resolved.startsWith(this._phraseCompletionsPath + path.sep)
      ) {
        broadcastIpcMessage('assets-provider', 'phrase-completions-updated')
      }
    })

    this._config.on('update', (option?: string) => {
      if (
        option !== undefined && option !== 'editor.snippetsFile' &&
        option !== 'editor.quickTexFile' && option !== 'editor.quickTexPluginDirectory'
      ) {
        return
      }
      if (option === undefined || option === 'editor.snippetsFile') {
        void this.configureSnippetsFile().catch(error => {
          this._logger.error(
            `[Assets Provider] Could not switch snippets file: ${error instanceof Error ? error.message : String(error)}`,
            error
          )
        })
      }
      if (option === undefined || option === 'editor.quickTexFile' || option === 'editor.quickTexPluginDirectory') {
        void this.configureQuickTexFile().catch(error => {
          this._logger.error(
            `[Assets Provider] Could not switch QuickTeX file: ${error instanceof Error ? error.message : String(error)}`,
            error
          )
        })
      }
    })

    ipcMain.handle('assets-provider', async (event, message: AssetsProviderIPCAPI) => {
      const { command, payload } = message
      // NOTE: Any *renderer* who requests a defaults file will always receive
      // the verbatim file contents, not a parsed object. Renderers who need to
      // work with the file contents programmatically should thus make use of
      // the bundled YAML module to parse and stringify the files accordingly.
      if (command === 'get-filter') {
        return await this.getFilter(payload.filename)
      } else if (command === 'set-filter') {
        return await this.setFilter(payload.filename, payload.contents)
      } else if (command === 'rename-filter') {
        return await this.renameFilter(payload.oldName, payload.newName)
      } else if (command === 'remove-filter') {
        return await this.removeFilter(payload.filename)
      } else if (command === 'list-filter') {
        return await this.listFilters()
      } else if (command === 'list-protected-filter') {
        return this.listProtectedFilters()
      } else if (command === 'open-filter-directory') {
        this._logger.info(`[Assets Provider] Opening path ${this._filterPath}`)
        return await shell.openPath(this._filterPath)
      } else if (command === 'get-defaults-file') {
        return await this.getDefaultsFileContents(payload.filename)
      } else if (command === 'set-defaults-file') {
        return await this.setDefaultsFile(payload.filename, payload.contents, true)
      } else if (command === 'rename-defaults-file') {
        return await this.renameDefaultsFile(payload.oldName, payload.newName)
      } else if (command === 'remove-defaults-file') {
        return await this.removeDefaultsFile(payload.filename)
      } else if (command === 'list-defaults') {
        return await this.listDefaults()
      } else if (command === 'list-export-profiles') {
        const profiles = await this.listDefaults()
        const scripts = isAppServiceContainerReady() ? getAppServiceContainer().config.get().export.scripts : []
        const custom = getCustomProfiles(scripts)
        // Custom profiles (e.g. the compile-pandoc PDF) override any same-named
        // defaults file. userData/defaults is copied once and never pruned, so a
        // stale shipped default (e.g. an old xelatex PDF.yaml renamed/removed in
        // a later version) can linger there; it must not shadow the custom
        // profile of the same name in the export menu.
        const customNames = new Set(custom.map(p => p.name))
        return profiles.filter(p => !customNames.has(p.name)).concat(custom)
      } else if (command === 'list-available-filters') {
        return await this.listAvailableFilters()
      } else if (command === 'open-defaults-directory') {
        this._logger.info(`[AssetsProvider] Opening path ${this._defaultsPath}`)
        return await shell.openPath(this._defaultsPath)
      } else if (command === 'get-snippets-source') {
        return await this.getSnippetsSource()
      } else if (command === 'set-snippets-source') {
        return await this.setSnippetsSource(payload.contents)
      } else if (command === 'list-snippets') {
        return await this.listSnippets()
      } else if (command === 'get-quicktex') {
        return this._quickTexCatalogue
      } else if (command === 'open-snippets-file') {
        this._logger.info(`[AssetsProvider] Opening path ${this._snippetsFile}`)
        return await shell.openPath(this._snippetsFile)
      } else if (command === 'list-phrase-completions') {
        return await loadPhraseDictionaries(this._phraseCompletionsPath)
      } else if (command === 'open-phrase-completions-directory') {
        this._logger.info(`[AssetsProvider] Opening path ${this._phraseCompletionsPath}`)
        return await shell.openPath(this._phraseCompletionsPath)
      }
    })
  }

  async boot (): Promise<void> {
    this._logger.verbose('Assets provider starting up ...')
    let phraseDirectoryExisted = true
    try {
      await fs.access(this._phraseCompletionsPath)
    } catch {
      phraseDirectoryExisted = false
      await fs.mkdir(this._phraseCompletionsPath, { recursive: true })
    }
    if (!phraseDirectoryExisted) {
      const starter = path.join(__dirname, './assets/completions')
      const files = (await fs.readdir(starter)).filter(file => file.endsWith('.txt'))
      for (const file of files) {
        await fs.copyFile(path.join(starter, file), path.join(this._phraseCompletionsPath, file))
      }
    }
    this._snippetsWatcher.add(this._phraseCompletionsPath)
    // First, ensure all required default files are where they should be.
    // Required are those defaults files which are in the assets/defaults
    // directory

    const defaultsFiles = await fs.readdir(path.join(__dirname, './assets/defaults'))
    const defaults = defaultsFiles.filter(file => /\.ya?ml$/.test(file))
    for (const file of defaults) {
      this._protectedDefaults.push(file)
      const absolutePath = path.join(this._defaultsPath, file)
      try {
        await fs.lstat(absolutePath)
      } catch {
        this._logger.warning(`[Assets Provider] Required defaults file ${file} not found. Copying ...`)
        await fs.copyFile(path.join(__dirname, './assets/defaults', file), absolutePath)
      }
    }

    // Next, do the same for the filters
    const filterFiles = await fs.readdir(path.join(__dirname, './assets/lua-filter'))
    const filters = filterFiles.filter(file => /\.lua$/.test(file))
    for (const file of filters) {
      this._protectedFilters.push(file)
      const absolutePath = path.join(this._filterPath, file)
      try {
        // If the file doesn't exist, lstat will throw an error. Otherwise, check
        // that the filter shipped with this version is newer. If so, replace.
        const existingStat = await fs.lstat(absolutePath)
        const newStat = await fs.lstat(path.join(__dirname, './assets/lua-filter', file))
        if (newStat.mtimeMs > existingStat.mtimeMs) {
          this._logger.warning(`[Assets Provider] Found outdated filter ${file}; copying ...`)
          await fs.copyFile(path.join(__dirname, './assets/lua-filter', file), absolutePath)
        }
      } catch {
        this._logger.warning(`[Assets Provider] Required filter ${file} not found. Copying ...`)
        await fs.copyFile(path.join(__dirname, './assets/lua-filter', file), absolutePath)
      }
    }

    await this.configureSnippetsFile()
    await this.configureQuickTexFile()
  }

  /**
   * Shuts down the provider
   *
   * @return  {Promise<void>} Resolves after successful shutdown
   */
  async shutdown (): Promise<void> {
    this._logger.verbose('Assets provider shutting down ...')
    await this._snippetsWatcher.close()
  }

  private configuredSnippetsFile (): string {
    const configured = String(this._config.get('editor.snippetsFile') ?? '').trim()
    const filePath = configured === '' ? this._defaultSnippetsFile : path.resolve(configured)
    if (!isSnippetFileName(path.basename(filePath))) {
      throw new Error(`Snippet file must use the .code-snippets extension: ${filePath}`)
    }
    return filePath
  }

  private async configureSnippetsFile (): Promise<void> {
    const nextFile = this.configuredSnippetsFile()
    await fs.mkdir(path.dirname(nextFile), { recursive: true })
    try {
      await fs.access(nextFile)
    } catch {
      await fs.writeFile(nextFile, '{}\n', { encoding: 'utf-8' })
    }
    if (this._snippetsFile !== '' && nextFile !== this._snippetsFile) {
      await this._snippetsWatcher.unwatch(this._snippetsFile)
    }
    this._snippetsFile = nextFile
    this._snippetsWatcher.add(this._snippetsFile)
    broadcastIpcMessage('assets-provider', 'snippets-updated')
  }

  private configuredQuickTexFile (): string {
    const configured = String(this._config.get('editor.quickTexFile') ?? '').trim()
    return configured === '' ? '' : path.resolve(configured)
  }

  private async configureQuickTexFile (): Promise<void> {
    const nextFile = this.configuredQuickTexFile()
    const pluginDirectory = String(this._config.get('editor.quickTexPluginDirectory') ?? '').trim()
    const resolvedPluginDirectory = pluginDirectory === '' ? '' : path.resolve(pluginDirectory)
    if (this._quickTexFile !== '' && nextFile !== this._quickTexFile) {
      await this._snippetsWatcher.unwatch(this._quickTexFile)
    }
    this._quickTexFile = nextFile
    try {
      if (this._quickTexFile !== '') {
        await fs.access(this._quickTexFile)
        this._snippetsWatcher.add(this._quickTexFile)
      }
      this._quickTexCatalogue = this._quickTexFile === '' || resolvedPluginDirectory === ''
        ? { prose: {}, math: {}, excludeChars: ['{', '(', '['], sourceFile: '', diagnostics: [] }
        : await loadQuickTex(this._quickTexFile, resolvedPluginDirectory)
      broadcastIpcMessage('assets-provider', 'quicktex-updated')
    } catch (error) {
      this._quickTexCatalogue = {
        prose: {},
        math: {},
        excludeChars: ['{', '(', '['],
        sourceFile: this._quickTexFile,
        diagnostics: [error instanceof Error ? error.message : String(error)]
      }
      broadcastIpcMessage('assets-provider', 'quicktex-updated')
      this._logger.error(
        `[Assets Provider] QuickTeX is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  /// //////////////////////////////  FILTERS  /////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  /**
   * Lists all filters installed in the system.
   *
   * @param   {string}           filename  The filter name
   *
   * @return  {Promise<string>}            The filter contents
   */
  async getFilter (filename: string): Promise<string> {
    const absPath = path.join(this._filterPath, filename)
    const lua = await fs.readFile(absPath, { encoding: 'utf-8' })
    return lua
  }

  /**
   * Creates/Updates the filter with the provided filename, using the contents.
   *
   * @param   {string}            filename  The filter name
   * @param   {string}            contents  The file contents
   *
   * @return  {Promise<boolean>}            Whether the command succeeded.
   */
  async setFilter (filename: string, contents: string): Promise<boolean> {
    filename = filename.trim()
    if (filename === '') {
      throw new Error('Cannot set Lua filter: Filename was empty.')
    }

    if (!/\.lua$/i.test(filename)) {
      filename += filename.endsWith('.') ? 'lua' : '.lua'
    }

    const absPath = path.join(this._filterPath, filename)

    try {
      // Stringify the new defaults according to the verbatim flag
      await fs.writeFile(absPath, contents)
      return true
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not save lua filter: ${err instanceof Error ? err.message : 'unknown error'}`, err)
      return false
    }
  }

  /**
   * Renames the provided filter.
   *
   * @param   {string}            oldName  The existing name
   * @param   {string}            newName  The new name
   *
   * @return  {Promise<boolean>}           Whether the command succeeded.
   */
  async renameFilter (oldName: string, newName: string): Promise<boolean> {
    newName = newName.trim()
    oldName = oldName.trim()
    if (newName === '' || oldName === '') {
      throw new Error('Cannot rename lua filter: Filename was empty.')
    }

    if (!/\.lua$/i.test(newName)) {
      newName += newName.endsWith('.') ? 'lua' : '.lua'
    }

    const oldPath = path.join(this._filterPath, oldName)
    const newPath = path.join(this._filterPath, newName)

    try {
      await fs.rename(oldPath, newPath)
      if (this._protectedFilters.includes(oldName)) {
        await this.restoreFilterFor(oldName)
      }
      return true
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not rename lua filter from ${oldPath} to ${newPath}.`, err)
      return false
    }
  }

  /**
   * Removes the filter with the provided name.
   *
   * @param   {string}            filename  The filter name
   *
   * @return  {Promise<boolean>}            Whether the command succeeded.
   */
  async removeFilter (filename: string): Promise<boolean> {
    const absPath = path.join(this._filterPath, filename)
    try {
      await fs.unlink(absPath)
      // If removing that file removed a protected one, restore it immediately.
      // This is effectively the same as restoring the file.
      if (this._protectedFilters.includes(filename)) {
        await this.restoreFilterFor(filename)
      }
      return true
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not remove lua filter: ${absPath}`, err)
      return false
    }
  }

  /**
   * Restores the file for a provided filter name.
   *
   * @param   {string}            filename  The filter name
   *
   * @return  {Promise<boolean>}            Whether the command succeeded.
   */
  async restoreFilterFor (filename: string): Promise<boolean> {
    const source = path.join(__dirname, './assets/lua-filter', filename)
    const target = path.join(this._filterPath, filename)

    try {
      await fs.copyFile(source, target)
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not restore filter file ${filename}!`, err)
      return false
    }

    return true
  }

  /**
   * Returns all LUA filters that have been found at the LUA filter path
   *
   * @param   {boolean}            returnAbsolutePaths  When `true` (default:
   *                                                    `false`), returns
   *                                                    absolute paths.
   *
   * @return  {Promise<string>[]}                       Resolves with an array
   *                                                    of filters.
   */
  async listFilters (returnAbsolutePaths: boolean = false): Promise<string[]> {
    const files = await fs.readdir(this._filterPath)
    return files
      .filter(file => /\.lua$/i.test(file))
      .map(file => returnAbsolutePaths ? path.join(this._filterPath, file) : file)
  }

  /**
   * Lists the Lua filters available to declare in the export filter chain,
   * discovered from Pandoc's data directory (~/.pandoc/filters) and Zettlr's own
   * lua-filter directory. Returns bare filenames, which resolve by name when
   * passed to Pandoc.
   *
   * @return  {Promise<string[]>}  Sorted, de-duplicated filter filenames.
   */
  async listAvailableFilters (): Promise<string[]> {
    const dirs = [ path.join(app.getPath('home'), '.pandoc', 'filters'), this._filterPath ]
    const names = new Set<string>()
    for (const dir of dirs) {
      const files = await fs.readdir(dir).catch(() => [] as string[])
      for (const file of files) {
        if (/\.lua$/i.test(file)) {
          names.add(file)
        }
      }
    }
    return Array.from(names).sort()
  }

  /**
   * Lists protected filters
   *
   * @return  {string[]}  A list of protected filters
   */
  public listProtectedFilters (): string[] {
    return this._protectedFilters
  }

  //////////////////////////////////////////////////////////////////////////////
  /// /////////////////////////////  DEFAULTS  /////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  /**
   * Gets the verbatim contents of a defaults file
   *
   * @param   {string}            filename   The profile's filename
   *
   * @return  {Promise<string>}              The unparsed YAML source
   */
  async getDefaultsFileContents (filename: string): Promise<string> {
    const absPath = path.join(this._defaultsPath, filename)
    return await fs.readFile(absPath, { encoding: 'utf-8' })
  }

  /**
   * Gets the defaults file for a given writer, parsed from YAML
   *
   * @param   {string}                             filename   The profile's filename
   *
   * @return  {Promise<Record<string, unknown>>}               The parsed defaults
   */
  async getDefaultsFile (filename: string): Promise<Record<string, unknown>> {
    const parsed: unknown = YAML.parse(await this.getDefaultsFileContents(filename))
    if (!isRecord(parsed)) {
      // Not an invariant: listDefaults read the file when it built the profile
      // list, but this reads it again, and the user can have saved a broken
      // file in between. The message therefore goes to the user, who is the
      // only one who can fix it.
      throw new Error(`Defaults file ${filename} must contain a YAML object, not ${describeValue(parsed)}. Edit the profile in Assets Manager.`)
    }
    return parsed
  }

  /**
   * Overwrites the defaults for a given writer.
   *
   * @param   {string}            filename      The file to write
   * @param   {string}            newDefaults   The new defaults
   * @param   {boolean}           verbatim      If false, newDefaults will be serialized to YAML
   *
   * @return  {Promise<boolean>}      Whether or not the operation was successful.
   */
  async setDefaultsFile (filename: string, newDefaults: string, verbatim: boolean = false): Promise<boolean> {
    filename = filename.trim()
    if (filename === '') {
      throw new Error('Cannot set defaults file: Filename was empty.')
    }

    if (!/\.ya?ml$/i.test(filename)) {
      filename += filename.endsWith('.') ? 'yaml' : '.yaml'
    }

    const absPath = path.join(this._defaultsPath, filename)

    try {
      // Stringify the new defaults according to the verbatim flag
      const yaml = (verbatim) ? newDefaults : YAML.stringify(newDefaults)
      await fs.writeFile(absPath, yaml)
      return true
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not save defaults file: ${err instanceof Error ? err.message : 'unknown error'}`, err)
      return false
    }
  }

  /**
   * Allows one to rename a defaults file
   *
   * @param   {string}            oldName  The former path to the file
   * @param   {string}            newName  The new path to the file
   *
   * @return  {Promise<boolean>}           True upon success
   */
  async renameDefaultsFile (oldName: string, newName: string): Promise<boolean> {
    newName = newName.trim()
    oldName = oldName.trim()
    if (newName === '' || oldName === '') {
      throw new Error('Cannot rename defaults file: Filename was empty.')
    }

    if (!/\.ya?ml$/i.test(newName)) {
      newName += newName.endsWith('.') ? 'yaml' : '.yaml'
    }

    const oldPath = path.join(this._defaultsPath, oldName)
    const newPath = path.join(this._defaultsPath, newName)

    try {
      await fs.rename(oldPath, newPath)
      // If renaming that file removed a protected one, restore it immediately.
      // This is effectively the same as duplicating the file.
      if (this._protectedDefaults.includes(oldName)) {
        await this.restoreDefaultsFor(oldName)
      }
      return true
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not rename file ${oldPath} to ${newPath}.`, err)
      return false
    }
  }

  /**
   * Removes the given defaults file. NOTE that any default profiles will be
   * restored on the next start of the app, so removing them will only be
   * temporary (e.g. for restoring purposes).
   *
   * @param   {string}            filename  The defaults file's name
   *
   * @return  {Promise<boolean>}           Returns true upon success
   */
  async removeDefaultsFile (filename: string): Promise<boolean> {
    const absPath = path.join(this._defaultsPath, filename)
    try {
      await fs.unlink(absPath)
      // If removing that file removed a protected one, restore it immediately.
      // This is effectively the same as restoring the file.
      if (this._protectedDefaults.includes(filename)) {
        await this.restoreDefaultsFor(filename)
      }
      return true
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not remove defaults file: ${absPath}`, err)
      return false
    }
  }

  /**
   * Restores the requested defaults file by copying it from the directory
   * within Zettlr into the defaults path (user data).
   *
   * @param   {string}             filename  The defaults file to copy over
   *
   * @return  {Promise<boolean>}           Returns true on success
   */
  async restoreDefaultsFor (filename: string): Promise<boolean> {
    const source = path.join(__dirname, './assets/defaults', filename)
    const target = path.join(this._defaultsPath, filename)

    try {
      await fs.copyFile(source, target)
    } catch (err: unknown) {
      this._logger.error(`[Assets Provider] Could not restore defaults file ${filename}!`, err)
      return false
    }

    return true
  }

  /**
   * Lists every Pandoc defaults file/profile installed
   *
   * @return  {Promise<PandocProfileMetadata[]>}The parsed metadata for all profiles
   */
  async listDefaults (): Promise<PandocProfileMetadata[]> {
    const profiles: PandocProfileMetadata[] = []

    const defaultsFiles = await fs.readdir(this._defaultsPath)
    const defaults = defaultsFiles.filter(file => /\.ya?ml$/.test(file))
    for (const file of defaults) {
      const profile = await this.readProfile(file)
      if (profile.isInvalid) {
        this._logger.warning(`[Assets Provider] Installed profile ${file} is unusable: ${profile.reason}`)
      }
      profiles.push(profile)
    }

    return profiles
  }

  /**
   * Reads one defaults file and decides, once and here, which kind of profile
   * it is. Every way a defaults file can fall short of a usable profile — it
   * cannot be read, it is not YAML, it is not a mapping, it declares no reader
   * or writer, it declares one of them as something other than a string, or it
   * speaks no format Zettlr knows — is a case the user can produce by editing
   * the file, so each returns the invalid variant with its own reason. The
   * invalid variant carries no reader and no writer at all.
   *
   * @param   {string}                            file  The defaults filename
   *
   * @return  {Promise<PandocProfileMetadata>}          The parsed profile
   */
  private async readProfile (file: string): Promise<PandocProfileMetadata> {
    const isProtected = this._protectedDefaults.includes(file)
    const invalid = (reason: string): InvalidPandocProfile => {
      return { name: file, isProtected, isInvalid: true, reason }
    }

    let contents: string
    try {
      contents = await fs.readFile(path.join(this._defaultsPath, file), { encoding: 'utf-8' })
    } catch (err: unknown) {
      return invalid(`the file could not be read: ${err instanceof Error ? err.message : 'unknown error'}`)
    }

    let parsed: unknown
    try {
      parsed = YAML.parse(contents)
    } catch (err: unknown) {
      return invalid(`the file is not valid YAML: ${err instanceof Error ? err.message : 'unknown error'}`)
    }

    if (!isRecord(parsed)) {
      return invalid(`the file holds ${describeValue(parsed)} where a YAML mapping was expected`)
    }

    const writer = stringProperty(parsed, 'writer')
    const reader = stringProperty(parsed, 'reader')
    const template = stringProperty(parsed, 'template')

    if (writer.kind === 'malformed') {
      return invalid(`the writer is ${writer.observed}, but it must be a string`)
    }

    if (reader.kind === 'malformed') {
      return invalid(`the reader is ${reader.observed}, but it must be a string`)
    }

    if (template.kind === 'malformed') {
      return invalid(`the template is ${template.observed}, but it must be a string`)
    }

    if (writer.kind === 'absent' || reader.kind === 'absent') {
      return invalid('the profile declares no reader, no writer, or neither')
    }

    // Zettlr can only use a profile if one of its two ends speaks one of
    // Zettlr's own formats, since one end is always a Zettlr document.
    const readsZettlr = SUPPORTED_READERS.includes(parseReaderWriter(reader.value).name)
    const writesZettlr = SUPPORTED_READERS.includes(parseReaderWriter(writer.value).name)
    if (!readsZettlr && !writesZettlr) {
      return invalid(`neither the reader "${reader.value}" nor the writer "${writer.value}" is a format Zettlr supports`)
    }

    return {
      name: file,
      isProtected,
      isInvalid: false,
      writer: writer.value,
      reader: reader.value,
      template: template.kind === 'string' ? template.value : undefined
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  /// /////////////////////////////  SNIPPETS  /////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  /** Read the configured portable VS Code snippet source verbatim. */
  async getSnippetsSource (): Promise<{ filePath: string, contents: string }> {
    return {
      filePath: this._snippetsFile,
      contents: await fs.readFile(this._snippetsFile, { encoding: 'utf-8' })
    }
  }

  /** Validate and write the configured portable VS Code snippet source. */
  async setSnippetsSource (contents: string): Promise<{ ok: true } | { ok: false, error: string }> {
    const parsed = parseVSCodeSnippetFile(path.basename(this._snippetsFile), contents)
    if (parsed.diagnostics.length > 0) {
      return { ok: false, error: parsed.diagnostics.map(diagnostic => diagnostic.message).join('\n') }
    }

    try {
      await fs.writeFile(this._snippetsFile, contents)
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._logger.error(`[Assets Provider] Could not save snippet file: ${message}`, err)
      return { ok: false, error: message }
    }
  }

  /** Parse the configured `.code-snippets` file into the editor catalogue. */
  async listSnippets (): Promise<SnippetCatalogue> {
    const sourceFile = path.basename(this._snippetsFile)
    const contents = await fs.readFile(this._snippetsFile, { encoding: 'utf-8' })
    const parsed = parseVSCodeSnippetFile(sourceFile, contents)
    const snippets: UserSnippet[] = parsed.snippets
    const diagnostics: SnippetFileDiagnostic[] = parsed.diagnostics
    for (const diagnostic of diagnostics) {
      this._logger.error(`[Assets Provider] Invalid snippet file ${diagnostic.sourceFile}: ${diagnostic.message}`)
    }
    return { snippets, diagnostics }
  }

}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Command loader
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file simply imports all commands, and exports them in
 *                  a unified object for easy instantiation by zettlr.ts.
 *
 * END HEADER
 */

import DirDelete from './dir-delete'
import DirNewProject from './dir-new-project'
import DirNew from './dir-new'
import DirProjectExport from './dir-project-export'
import DirRemoveProject from './dir-remove-project'
import DirRename from './dir-rename'
import DirRescan from './dir-rescan'
import DirSettings from './dir-settings'
import DirSort from './dir-sort'
import Export from './export'
import FetchLinkPreview from './fetch-link-preview'
import FileDelete from './file-delete'
import FileDuplicate from './file-duplicate'
import FileNew from './file-new'
import FileRename from './file-rename'
import FileSearch from './file-search'
import ForceOpen from './force-open'
import FileFindAndReturnMetaData from './file-find-and-return-meta-data'
import ImportLangFile from './import-lang-file'
import ImportFiles from './import'
import IncreasePomodoro from './increase-pomodoro'
import LanguageTool from './language-tool'
import OpenAttachment from './open-attachment'
import OpenAuxWindow from './open-aux-window'
import Print from './print'
import RequestMove from './request-move'
import RootClose from './root-close'
import RootOpen from './root-open'
import SaveImageFromClipboard from './save-image-from-clipboard'
import TutorialOpen from './tutorial-open'
import UpdateProjectProperties from './update-project-properties'
import UpdateUserDictionary from './update-user-dictionary'
import ProviderContract from '@providers/provider-contract'
import { type AppServiceContainer } from 'source/app/app-service-container'
import type ZettlrCommand from './zettlr-command'
import { clipboard, ipcMain, nativeImage } from 'electron'
import enumLangFiles from '@common/util/enum-lang-files'
import enumDictFiles from '@common/util/enum-dict-files'
import RenameTag from './rename-tag'
import RenameReference from './rename-reference'
import TikzRender from './tikz-render'
import FormatDocument from './format-document'
import WorkspaceSort from './ws-sort'
import type { CustomExportIPCAPI, ExportIPCAPI } from './export'
import type { ForceOpenAPI } from './force-open'
import type { SaveImageFromClipboardAPI } from './save-image-from-clipboard'
import type { DirSettingsCommandAPI } from './dir-settings'
import type { TikzRenderRequest } from 'source/app/util/tikz-render'
import type { LanguageToolLinterRequest } from './language-tool'
import type { LanguageToolIgnoredRuleEntry } from '../config/get-config-template'
import type { ProgrammaticallyOpenableWindows } from './open-aux-window'
import type { DocumentType } from '@dts/common/documents'
import type { WorkspaceReferenceEdit } from '@dts/common/references'
import type { ProjectSettings } from '@dts/common/fsal'

export const commands = [
  DirDelete,
  DirNewProject,
  DirNew,
  DirProjectExport,
  DirRemoveProject,
  DirRename,
  DirRescan,
  DirSettings,
  DirSort,
  Export,
  FetchLinkPreview,
  FileDelete,
  FileDuplicate,
  FileNew,
  FileRename,
  FileSearch,
  FileFindAndReturnMetaData,
  ForceOpen,
  ImportFiles,
  ImportLangFile,
  IncreasePomodoro,
  LanguageTool,
  OpenAttachment,
  OpenAuxWindow,
  Print,
  RenameReference,
  RenameTag,
  FormatDocument,
  RequestMove,
  RootClose,
  RootOpen,
  SaveImageFromClipboard,
  TikzRender,
  TutorialOpen,
  UpdateProjectProperties,
  UpdateUserDictionary,
  WorkspaceSort
]

/**
 * The wire contract of the 'application' ipc channel: every command the
 * renderer may run through CommandProvider.run(), with its payload. This
 * union is the single owner of the channel's request shape; the renderer
 * bridge imports it so a wrong command or payload fails to compile at the
 * call site. When a new command becomes renderer-invokable, add it here.
 */
export type ApplicationIPCAPI =
  | { command: 'add-language-tool-ignore-rule', payload: LanguageToolIgnoredRuleEntry }
  | { command: 'commit-reference-rename', payload: { edit: WorkspaceReferenceEdit } }
  | { command: 'custom-export', payload: CustomExportIPCAPI }
  | { command: 'dir-delete', payload: { path: string } }
  | { command: 'dir-new', payload?: { path?: string, name?: string } }
  | { command: 'dir-new-project', payload: { path: string } }
  | { command: 'dir-project-export', payload: string }
  | { command: 'dir-remove-project', payload: { path: string } }
  | { command: 'dir-rename', payload: { path: string, name: string } }
  | { command: 'dir-sort', payload: { path: string, sorting: string } }
  | { command: 'export', payload: ExportIPCAPI }
  | { command: 'fetch-link-preview', payload: string }
  | { command: 'file-find-and-return-meta-data', payload: string }
  | { command: 'file-delete', payload: { path: string } }
  | { command: 'file-duplicate', payload: { path: string, windowId?: string, leafId?: string|undefined } }
  | { command: 'file-new', payload?: { path?: string, name?: string, type?: DocumentType } }
  | { command: 'file-rename', payload: { path: string, name: string } }
  | { command: 'find-exact', payload: string }
  | { command: 'force-open', payload: ForceOpenAPI }
  | { command: 'format-document', payload: string }
  | { command: 'get-available-dictionaries', payload?: undefined }
  | { command: 'get-available-languages', payload?: undefined }
  | { command: 'get-file-contents', payload: string }
  | { command: 'open-attachment', payload: { citekey: string, filePath: string } }
  | { command: 'open-aux-window', payload: { window: ProgrammaticallyOpenableWindows, hash?: string } }
  | { command: 'open-preferences', payload?: undefined }
  | { command: 'open-project-preferences', payload: string }
  | { command: 'open-stats-window', payload?: undefined }
  | { command: 'open-update-window', payload?: undefined }
  | { command: 'preview-reference-rename', payload: { oldKey: string, newKey: string } }
  | { command: 'print', payload?: string }
  | { command: 'rename-tag', payload: { oldName: string, newName: string } }
  | { command: 'request-move', payload: { from: string, to: string } }
  | { command: 'root-close', payload: string }
  | { command: 'root-open-workspaces', payload?: undefined }
  | { command: 'root-open-files', payload?: undefined }
  | { command: 'roots-add', payload: string[] }
  | { command: 'run-language-tool', payload: LanguageToolLinterRequest }
  | { command: 'save-image-from-clipboard', payload: SaveImageFromClipboardAPI | { startPath: string } }
  | { command: 'set-directory-setting', payload: DirSettingsCommandAPI }
  | { command: 'sort-workspaces', payload: string[] }
  | { command: 'tikz-render', payload: TikzRenderRequest }
  | { command: 'undo-reference-rename', payload?: undefined }
  | { command: 'update-project-properties', payload: { path: string, properties: ProjectSettings } }

export default class CommandProvider extends ProviderContract {
  private readonly _commands: ZettlrCommand[]

  // TODO: Right now this just injects the full service container into the
  // commands, but it mayt be better to only provide those which are actually
  // required.
  constructor (private readonly _app: AppServiceContainer) {
    super()
    // Load available commands
    this._commands = commands.map(Command => new Command(this._app))

    // Set up the command listener
    ipcMain.handle('application', async (event, { command, payload }) => {
      if (typeof command === 'string') {
        return await this.run(command, payload)
      } else {
        throw new Error(`[Commands] Could not run command "${String(command)}": Not a string`)
      }
    })
  }

  /**
   * Runs a command through the application pipeline
   *
   * @param   {string}  command  The command to run
   * @param   {any}     payload  Any payload, as required depending on the command.
   *
   * @return  {Promise<any>}     The return from running the command
   */
  async run (command: string, payload: unknown): Promise<unknown> {
    // FIRST: Try to run a minimal command for which its own custom function
    // wouldn't make sense.
    if (command === 'copy-img-to-clipboard') {
      // We should copy the contents of an image file to clipboard. Payload
      // contains the image path. We can rely on the Electron framework here.
      if (typeof payload !== 'string') {
        return false
      }

      let imgPath = payload
      if (imgPath.startsWith('safe-file://')) {
        imgPath = imgPath.replace('safe-file://', '')
      } else if (imgPath.startsWith('file://')) {
        imgPath = imgPath.replace('file://', '')
      }

      // Due to the colons in the drive letters on Windows, the pathname will
      // look like this: /C:/Users/Documents/test.jpg
      // See: https://github.com/Zettlr/Zettlr/issues/5489
      if (/^\/[A-Z]:/i.test(imgPath)) {
        imgPath = imgPath.slice(1)
      }

      const img = nativeImage.createFromPath(imgPath)

      if (!img.isEmpty()) {
        clipboard.writeImage(img)
      }
      return true
    } else if (command === 'get-file-contents' && typeof payload === 'string') {
      // Some renderer's editor has requested a file
      return await this._app.fsal.loadAnySupportedFile(payload)
    } else if (command === 'open-preferences') {
      this._app.windows.showPreferences()
      return true
    } else if (command === 'open-stats-window') {
      this._app.windows.showStatsWindow()
      return true
    } else if (command === 'open-update-window') {
      this._app.windows.showUpdateWindow()
    } else if (command === 'open-project-preferences' && typeof payload === 'string') {
      this._app.windows.showProjectPropertiesWindow(payload)
    } else {
      // ELSE: If the command has not yet been found, try to run one of the
      // bigger commands
      const cmd: ZettlrCommand|undefined = this._commands.find((elem: ZettlrCommand) => elem.respondsTo(command))
      if (cmd !== undefined) {
        // Return the return value of the command, if there is any
        try {
          return await cmd.run(command, payload)
        } catch (err: unknown) {
          this._app.log.error('[Application] Error received while running command: ' + (err instanceof Error ? err.message : 'Unknown error'), err)
          return false
        }
      } else if (command === 'get-available-languages') {
        return enumLangFiles().map(elem => elem.tag)
      } else if (command === 'get-available-dictionaries') {
        return enumDictFiles().map(elem => elem.tag)
      } else {
        // Nothing answered for this name. The result channel is the caller's
        // only evidence of what happened, and ipcMain.handle turns a plain
        // return into a RESOLVED invoke() — so logging and falling out would
        // report success for work that never ran. Throwing is what keeps an
        // unimplemented command indistinguishable from a failing one.
        throw new Error(`[Commands] Could not run command "${command}": Not registered.`)
      }
    }
  }

  async shutdown (): Promise<void> {
    this._app.log.verbose('Command Provider shutting down ...')
  }
}

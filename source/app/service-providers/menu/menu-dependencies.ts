import type CommandProvider from '@providers/commands'
import type DocumentManager from '@providers/documents'
import type LogProvider from '@providers/log'
import type RecentDocumentsProvider from '@providers/recent-docs'
import type WindowProvider from '@providers/windows'

export type MenuLogger = Pick<LogProvider, 'error'>
export type MenuRecentDocuments = Pick<RecentDocumentsProvider, 'get' | 'clear'>
export type MenuCommands = Pick<CommandProvider, 'run'>
export type MenuWindows = Pick<
WindowProvider,
| 'showAboutWindow'
| 'showDefaultsWindow'
| 'showLogWindow'
| 'showPreferences'
| 'showTagManager'
>
export type MenuDocuments = Pick<DocumentManager, 'newWindow' | 'openFile'>

type MenuConfigWrite =
  | [key: 'darkMode'|'fileMeta', value: boolean]
  | [key: 'editor.fontSize', value: number]

/**
 * The application menu reads four configuration fields and can toggle two of
 * them. Keeping that capability explicit lets callers provide the real config
 * provider without making menu construction depend on every private detail of
 * that provider.
 */
export interface MenuConfig {
  get: {
    (): { editor: { fontSize: number } }
    (key: 'system.zoomBehavior' | 'darkMode' | 'fileMeta' | 'debug'): unknown
  }
  set: (...args: MenuConfigWrite) => void
}

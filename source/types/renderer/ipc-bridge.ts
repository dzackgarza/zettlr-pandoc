/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer IPC bridge contracts
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The typed surface of window.ipc.invoke (issue #50). Every
 *                  channel a renderer may invoke is enumerated here together
 *                  with its request contract and — where the owning handler's
 *                  return type is recorded — its per-command response type.
 *                  global.d.ts references IpcInvoke, so a wrong channel or a
 *                  wrong payload is a compile error at the call site instead
 *                  of an `any` that silently spreads.
 *
 *                  Ownership: providers that already declare an XxxIPCAPI
 *                  next to their ipcMain.handle() remain the single owners
 *                  and are imported here. Channels whose provider modules
 *                  still carry pre-existing whole-file lint debt (fsal,
 *                  link-provider, update-provider, targets-provider,
 *                  tag-provider, dictionary-provider, css-provider,
 *                  stats-provider, menu-provider, log-provider,
 *                  appearance-provider) have their request unions recorded
 *                  HERE, transcribed from the owning handler; each should
 *                  migrate next to its handler when that file is brought
 *                  under the commit gate.
 *
 *                  Response semantics of ResponseFor:
 *                  - literal command, recorded response  -> that exact type
 *                  - literal command, unrecorded response -> unknown (narrow
 *                    or record the contract; never a silent any)
 *                  - request cast to a whole XxxIPCAPI union -> never: a
 *                    message of statically-unknown command has no statically
 *                    known response. Drop the cast and pass the literal to
 *                    get a typed response.
 *
 * END HEADER
 */

import type { GetTextTranslations } from 'gettext-parser'
import type DocumentManager from 'source/app/service-providers/documents'
import type {
  DocumentAuthorityIPCAPI,
  DocumentManagerIPCAPI,
  SaveFileResult
} from 'source/app/service-providers/documents'
import type { ApplicationIPCAPI } from 'source/app/service-providers/commands'
import type { ReferenceProviderIPCAPI } from 'source/app/service-providers/references'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import type { CiteprocProviderIPCAPI } from 'source/app/service-providers/citeproc'
import type { AssetsProviderIPCAPI, PandocProfileMetadata } from 'source/app/service-providers/assets'
import type { SearchProviderIPCAPI } from 'source/app/service-providers/search'
import type {
  LRTIPCAsyncMessage,
  LRTIPCSyncMessage
} from 'source/app/service-providers/long-running-tasks'
import type { LRT_JSON } from 'source/app/service-providers/long-running-tasks/task'
import type {
  CloseAllIPCAPI,
  RequestFilesIPCAPI
} from 'source/app/service-providers/windows'
import type { OnboardingIPCMessage } from 'source/app/service-providers/config/onboarding-window'
import type { UpdateState } from 'source/app/service-providers/updates'
import type { WritingTarget } from 'source/app/service-providers/targets'
import type { ColoredTag, TagRecord } from 'source/app/service-providers/tags'
import type { LogMessage } from 'source/app/service-providers/log'
import type { Stats } from 'source/app/service-providers/stats'
import type { FindFileAndReturnMetadataResult } from 'source/app/service-providers/commands/file-find-and-return-meta-data'
import type { LanguageToolLinterResponse } from 'source/app/service-providers/commands/language-tool'
import type { TikzRenderResult } from 'source/app/util/tikz-render'
import type { MathJaxMacro } from 'source/common/util/mathjax-config'
import type { FormatResult } from 'source/common/modules/markdown-editor/commands/format-document'
import type { LinkPreviewResult } from 'source/common/util/fetch-link-preview'
import type { AnyDescriptor, MDFileDescriptor } from 'source/types/common/fsal'
import type { ReviewDiffSession } from 'source/types/common/review-diff'
import type { SerializedUpdate } from 'source/types/common/documents'
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome
} from 'source/common/pandoc-util/compute-reference-edits'

/**
 * Requests of channels whose provider modules could not yet host the type
 * (see the header); transcribed from the owning ipcMain.handle() bodies.
 */
export type FSALIPCAPI =
  | { command: 'read-path-recursively', payload: string }
  | { command: 'read-directory', payload: string }
  | { command: 'get-descriptor', payload: string|string[] }

export type LinkProviderIPCAPI =
  | { command: 'get-inbound-links', payload: { filePath: string } }
  | { command: 'get-link-database', payload?: undefined }

export type UpdateProviderIPCAPI =
  | { command: 'check-for-update', payload?: undefined }
  | { command: 'update-status', payload?: undefined }
  | { command: 'request-app-update', payload: string }
  | { command: 'begin-update', payload?: undefined }

export type TargetProviderIPCAPI =
  | { command: 'get-targets', payload?: undefined }
  | { command: 'set-writing-target', payload: WritingTarget }

export type TagProviderIPCAPI =
  | { command: 'get-all-tags', payload?: undefined }
  | { command: 'get-colored-tags', payload?: undefined }
  | { command: 'set-colored-tags', payload: ColoredTag[] }

/**
 * The term commands carry terms at the message's top level, not in payload.
 * 'set-user-dictionary' takes unknown because the handler owns validation (it
 * throws unless the payload is a string array) and its one caller forwards a
 * generic preferences-form value.
 */
export type DictionaryProviderIPCAPI =
  | { command: 'check'|'suggest'|'add', terms: string[] }
  | { command: 'get-user-dictionary' }
  | { command: 'set-user-dictionary', payload: unknown }
  | { command: 'open-dictionary-folder' }

/** 'set-custom-css' carries its css at the message's top level. */
export type CSSProviderIPCAPI =
  | { command: 'get-custom-css-path' }
  | { command: 'get-custom-css' }
  | { command: 'set-custom-css', css: string }

export type StatsProviderIPCAPI = { command: 'get-data', payload?: undefined }

/** The menu tree is an opaque serialized structure the provider validates. */
export type MenuProviderIPCAPI = {
  command: 'display-native-context-menu'
  payload: { menu: unknown, x: number, y: number }
}

export type AppearanceProviderIPCAPI = { command: 'get-accent-color', payload?: undefined }

/** nextIndex lives at the message's top level. */
export type LogProviderIPCAPI = { command: 'retrieve-log-chunk', nextIndex: number }

/**
 * Every channel that takes a message, mapped to its request contract.
 */
export interface IpcRequestMap {
  'application': ApplicationIPCAPI
  'documents-provider': DocumentManagerIPCAPI
  'documents-authority': DocumentAuthorityIPCAPI
  'reference-provider': ReferenceProviderIPCAPI
  'citeproc-provider': CiteprocProviderIPCAPI
  'assets-provider': AssetsProviderIPCAPI
  'search-provider': SearchProviderIPCAPI
  'lrt-provider': LRTIPCSyncMessage|LRTIPCAsyncMessage
  'onboarding': OnboardingIPCMessage
  'request-files': RequestFilesIPCAPI
  'close-all': CloseAllIPCAPI
  'fsal': FSALIPCAPI
  'link-provider': LinkProviderIPCAPI
  'update-provider': UpdateProviderIPCAPI
  'targets-provider': TargetProviderIPCAPI
  'tag-provider': TagProviderIPCAPI
  'dictionary-provider': DictionaryProviderIPCAPI
  'css-provider': CSSProviderIPCAPI
  'stats-provider': StatsProviderIPCAPI
  'menu-provider': MenuProviderIPCAPI
  'appearance-provider': AppearanceProviderIPCAPI
  'log-provider': LogProviderIPCAPI
}

/** Channels invoked without any message, mapped to their response. */
export interface IpcBareChannelResponseMap {
  'i18n': GetTextTranslations|undefined
  'mathjax-macros': Record<string, MathJaxMacro>
  'request-dir': string[]
  'paste-image-retrieve-data': {
    dataUrl: string
    name: string
    size: { width: number, height: number }
    aspect: number
  }
}

/** Message channels whose response does not depend on a command property. */
interface IpcFixedResponseMap {
  'request-files': string[]
  'close-all': boolean
}

/**
 * Recorded per-command responses, keyed by channel then command. A command
 * missing here resolves to unknown — record the handler's return type here
 * when a call site needs it.
 */
interface IpcCommandResponseMap {
  'documents-provider': {
    'save-file': SaveFileResult
    'get-review-diff-session': ReviewDiffSession|undefined
    'decide-review-chunk': ReturnType<DocumentManager['decideChunk']>
    'accept-all-review-chunks': ReturnType<DocumentManager['acceptAllChunks']>
    'get-navigation-state': ReturnType<DocumentManager['getNavigationState']>
    'get-open-workspace-files': Awaited<ReturnType<DocumentManager['getFilesForWorkspace']>>
    'get-file-modification-status': string[]
  }
  'documents-authority': {
    'get-document': Awaited<ReturnType<DocumentManager['getDocument']>>
    // pullUpdates/pushUpdates are private on the manager; transcribed.
    'pull-updates': SerializedUpdate[]|false
    'push-updates': boolean
  }
  'reference-provider': {
    'get-snapshot': WorkspaceReferenceState
  }
  'citeproc-provider': {
    'get-items': CSLItem[]
    'get-citation': string|undefined
    'get-bibliography': [BibliographyOptions, string[]]|undefined
  }
  'application': {
    'preview-reference-rename': ReferenceRenamePreview
    'commit-reference-rename': CommitRenameOutcome
    'undo-reference-rename': UndoRenameOutcome
    'get-file-contents': string
    'tikz-render': TikzRenderResult
    'save-image-from-clipboard': string|undefined
    'file-find-and-return-meta-data': FindFileAndReturnMetadataResult|undefined
    'get-available-languages': string[]
    'get-available-dictionaries': string[]
    'find-exact': MDFileDescriptor|undefined
    'run-language-tool': LanguageToolLinterResponse
    'format-document': FormatResult
    'fetch-link-preview': LinkPreviewResult|undefined
  }
  'assets-provider': {
    'list-snippets': string[]
    'get-snippet': string
    'list-filter': string[]
    'list-protected-filter': string[]
    'list-available-filters': string[]
    'get-filter': string
    'list-defaults': PandocProfileMetadata[]
    'list-export-profiles': PandocProfileMetadata[]
    'get-defaults-file': string
  }
  'fsal': {
    'read-path-recursively': string[]
    'read-directory': AnyDescriptor[]
    'get-descriptor': AnyDescriptor|AnyDescriptor[]|undefined
  }
  'link-provider': {
    'get-link-database': Record<string, string[]>
    'get-inbound-links': { inbound: string[], outbound: string[] }
  }
  'update-provider': {
    'update-status': UpdateState
  }
  'targets-provider': {
    'get-targets': WritingTarget[]
  }
  'tag-provider': {
    'get-colored-tags': ColoredTag[]
    'get-all-tags': TagRecord[]
  }
  'dictionary-provider': {
    'check': boolean[]
    'suggest': string[][]
    'add': boolean[]
    'get-user-dictionary': string[]
  }
  'css-provider': {
    'get-custom-css': string
    'get-custom-css-path': string
  }
  'stats-provider': {
    'get-data': Stats
  }
  'menu-provider': {
    'display-native-context-menu': string|undefined
  }
  'appearance-provider': {
    'get-accent-color': { accent: string, contrast: string }
  }
  'log-provider': {
    'retrieve-log-chunk': LogMessage[]
  }
  'lrt-provider': {
    'get-tasks': LRT_JSON[]
  }
}

/** The command literal of a request message, if any. */
type CommandOf<M> = M extends { command: infer C extends string } ? C : never

/** True exactly when the string-literal union T has a single member. */
type IsSingleton<T extends string> = [T] extends [never] ? false : (
  { [K in T]: Exclude<T, K> extends never ? true : false }[T]
)

/**
 * The response of invoking channel C with message M — see the header for the
 * three-way semantics (exact type / unknown / never).
 */
export type IpcResponseFor<C extends keyof IpcRequestMap, M> =
  C extends keyof IpcFixedResponseMap
    ? IpcFixedResponseMap[C]
    : C extends keyof IpcCommandResponseMap
      ? IsSingleton<CommandOf<M>> extends true
        ? CommandOf<M> extends keyof IpcCommandResponseMap[C]
          ? IpcCommandResponseMap[C][CommandOf<M>]
          : unknown
        : never
      : unknown

/**
 * The type of window.ipc.invoke. The R parameter lets a call site narrow a
 * recorded response to a subtype it can prove (or an unrecorded unknown to
 * its operative type) via a plain annotation — never widen past the recorded
 * contract, and never produce any.
 */
export interface IpcInvoke {
  <C extends keyof IpcRequestMap, M extends IpcRequestMap[C], R extends IpcResponseFor<C, M> = IpcResponseFor<C, M>>(
    channel: C,
    message: M
  ): Promise<R>
  <C extends keyof IpcBareChannelResponseMap>(channel: C): Promise<IpcBareChannelResponseMap[C]>
}

declare global {
  /**
   * The typed surface of window.ipc.invoke, aliased into the global scope so
   * the ambient Window declaration in source/global.d.ts (which cannot use
   * import statements or import() annotations) can reference it.
   */
  type ZettlrIpcInvoke = IpcInvoke
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer IPC invoke and broadcast composition
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The typed surface of window.ipc.invoke and window.ipc.on,
 *                  composed from provider-owned contracts. Nothing is
 *                  declared here: every request and response type lives
 *                  beside the ipcMain handler that implements it, and every
 *                  broadcast payload beside the main-process code that sends
 *                  it (for modules with pre-existing whole-file lint debt, in
 *                  a small ipc-contract.ts in the same module directory).
 *                  This file only assembles those owner-exported types into
 *                  two channel tables: IpcInvokeContracts (a window asks the
 *                  main process) and IpcBroadcastContracts (the main process
 *                  tells a window). The invoke signature, the listener
 *                  signature of window.ipc.on and the signatures of the
 *                  main-process senders derive from them.
 *
 * END HEADER
 */

import type { IpcEmitter } from "@electron-toolkit/typed-ipc/renderer";
import type {
  MathJaxMacrosIPCResponse,
  TexMacroCommandsIPCResponse,
  TikzCompletionIPCResponse,
} from "source/app/lifecycle";
import type { AppearanceProviderIPCContract } from "source/app/service-providers/appearance/ipc-contract";
import type {
  AssetsProviderBroadcast,
  AssetsProviderIPCContract,
} from "source/app/service-providers/assets";
import type { CiteprocIPCContract } from "source/app/service-providers/citeproc";
import type { ApplicationIPCContract } from "source/app/service-providers/commands";
import type { PasteImageRetrieveDataIPCResponse } from "source/app/service-providers/commands/save-image-from-clipboard";
import type { TikzEditEvent } from "source/app/service-providers/commands/tikz-edit";
import type { ConfigProviderBroadcast } from "source/app/service-providers/config";
import type { OnboardingIPCContract } from "source/app/service-providers/config/onboarding-window";
import type {
  CSSProviderBroadcast,
  CSSProviderIPCContract,
} from "source/app/service-providers/css/ipc-contract";
import type {
  DictionaryProviderBroadcast,
  DictionaryProviderIPCContract,
} from "source/app/service-providers/dictionary/ipc-contract";
import type {
  DocumentAuthorityIPCContract,
  DocumentIpcHandlers,
  DocumentManagerIPCContract,
  DocumentsUpdateBroadcast,
} from "source/app/service-providers/documents";
import type { FSALEventPayload } from "source/app/service-providers/fsal";
import type { FsalIPCContract } from "source/app/service-providers/fsal/ipc-contract";
import type { LinkProviderIPCContract } from "source/app/service-providers/links/ipc-contract";
import type { LogProviderIPCContract } from "source/app/service-providers/log/ipc-contract";
import type { LRTBroadcast, LRTIPCContract } from "source/app/service-providers/long-running-tasks";
import type { MenuProviderIPCContract } from "source/app/service-providers/menu/ipc-contract";
import type { ReferenceProviderIPCContract } from "source/app/service-providers/references";
import type {
  SearchProviderBroadcast,
  SearchProviderIPCContract,
} from "source/app/service-providers/search";
import type { Stats } from "source/app/service-providers/stats";
import type { StatsProviderIPCContract } from "source/app/service-providers/stats/ipc-contract";
import type {
  TagProviderBroadcast,
  TagProviderIPCContract,
} from "source/app/service-providers/tags/ipc-contract";
import type {
  TargetProviderBroadcast,
  TargetProviderIPCContract,
} from "source/app/service-providers/targets/ipc-contract";
import type {
  UpdateProviderBroadcast,
  UpdateProviderIPCContract,
} from "source/app/service-providers/updates/ipc-contract";
import type {
  CloseAllIPCContract,
  JumpToLineBroadcast,
  RequestDirIPCResponse,
  RequestFilesIPCContract,
  WindowControlsBroadcast,
} from "source/app/service-providers/windows";
import type { SplashStepBroadcast } from "source/app/util/splash-screen";
import type { I18nIPCResponse } from "source/common/i18n-main";
import type { IgnoreRuleSources } from "source/common/util/ignore-rules";
import type {
  CITEPROC_PROBLEMS_CHANNEL,
  CitationResourceProblem,
} from "source/types/common/citeproc";
import type {
  COMMAND_FAILED_CHANNEL,
  CommandFailedBroadcast,
} from "source/types/common/command-failure";
import type {
  COLLABORATION_FILE_UNREADABLE_CHANNEL,
  COLLABORATION_FILE_UNWRITABLE_CHANNEL,
  CollaborationFileUnreadableBroadcast,
  CollaborationFileUnwritableBroadcast,
} from "source/types/common/document-collaboration";
import type {
  FILE_REMOVED_KEPT_CHANNEL,
  FileRemovedKeptBroadcast,
  REMOTE_CHANGE_KEPT_CHANNEL,
  RemoteChangeKeptBroadcast,
  SAVE_REFUSED_CHANNEL,
  SaveRefusedBroadcast,
} from "source/types/common/documents";
import type { Cloneable } from "source/types/common/ipc";
import type { PreferenceNavigationTarget } from "source/types/common/preferences";
import type { MenuProviderMessage } from "source/types/common/serialized-menu";
import type { InsertTableBroadcast, ShortcutBroadcast } from "source/types/common/shortcut-names";
import type {
  WORKSPACE_EDIT_PROPOSAL_CHANNEL,
  WorkspaceEditProposal,
} from "source/types/common/workspace-edit";

/**
 * Every multiplexer channel, mapped to its owner-exported contract.
 */
export interface IpcInvokeContracts {
  application: ApplicationIPCContract;
  "documents-provider": DocumentManagerIPCContract;
  "documents-authority": DocumentAuthorityIPCContract;
  "reference-provider": ReferenceProviderIPCContract;
  "citeproc-provider": CiteprocIPCContract;
  "assets-provider": AssetsProviderIPCContract;
  "search-provider": SearchProviderIPCContract;
  "lrt-provider": LRTIPCContract;
  onboarding: OnboardingIPCContract;
  fsal: FsalIPCContract;
  "link-provider": LinkProviderIPCContract;
  "update-provider": UpdateProviderIPCContract;
  "targets-provider": TargetProviderIPCContract;
  "tag-provider": TagProviderIPCContract;
  "dictionary-provider": DictionaryProviderIPCContract;
  "css-provider": CSSProviderIPCContract;
  "stats-provider": StatsProviderIPCContract;
  "menu-provider": MenuProviderIPCContract;
  "appearance-provider": AppearanceProviderIPCContract;
  "log-provider": LogProviderIPCContract;
}

/**
 * Channels whose message carries no command discriminant: one fixed request
 * shape, one fixed response, owner-exported as a single contract entry.
 */
export interface IpcFixedChannelContracts {
  "request-files": RequestFilesIPCContract;
  "close-all": CloseAllIPCContract;
}

/**
 * Channels invoked bare (no message), mapped to their owner-declared
 * response.
 */
export interface IpcBareChannelContracts {
  i18n: I18nIPCResponse;
  "mathjax-macros": MathJaxMacrosIPCResponse;
  "tex-macro-commands": TexMacroCommandsIPCResponse;
  "tikz-completion-commands": TikzCompletionIPCResponse;
  "request-dir": RequestDirIPCResponse;
  "paste-image-retrieve-data": PasteImageRetrieveDataIPCResponse;
}

/** The request half of one contract entry. */
type IpcRequestOf<E> = E extends { request: infer R } ? R : never;

/** The response half of one contract entry. */
type IpcResponseOf<E> = E extends { response: infer R } ? R : never;

/**
 * The invoke signature derived from the channel table: a literal command
 * resolves to its owner-declared response, and a wrong channel, command, or
 * payload is a compile error at the call site. A caller gets the response
 * that the owner declares; a caller that needs a narrower value examines the
 * response.
 */
export interface IpcInvoke {
  <C extends keyof IpcInvokeContracts, K extends keyof IpcInvokeContracts[C] & string>(
    channel: C,
    message: { command: K } & IpcRequestOf<IpcInvokeContracts[C][K]>,
  ): Promise<IpcResponseOf<IpcInvokeContracts[C][K]>>;
  <C extends keyof IpcFixedChannelContracts>(
    channel: C,
    message: IpcFixedChannelContracts[C]["request"],
  ): Promise<IpcFixedChannelContracts[C]["response"]>;
  <C extends keyof IpcBareChannelContracts>(channel: C): Promise<IpcBareChannelContracts[C]>;
}

/**
 * Every channel on which the main process sends a window a message, mapped
 * to the arguments that a listener of window.ipc.on gets after its event.
 * The senders (broadcastIPCMessage, tellMainWindows, sendIPCMessage,
 * replyIPCMessage) take the same arguments. A channel whose message has more
 * than one shape declares the union of every shape that a sender sends.
 */
export interface IpcBroadcastContracts {
  shortcut: ShortcutBroadcast;
  "insert-table": InsertTableBroadcast;
  "window-controls": [message: WindowControlsBroadcast];
  "jump-to-line": [target: JumpToLineBroadcast];
  "preferences-navigate": [target: PreferenceNavigationTarget];
  "step-update": [step: SplashStepBroadcast];
  [SAVE_REFUSED_CHANNEL]: [message: SaveRefusedBroadcast];
  [REMOTE_CHANGE_KEPT_CHANNEL]: [message: RemoteChangeKeptBroadcast];
  [FILE_REMOVED_KEPT_CHANNEL]: [message: FileRemovedKeptBroadcast];
  [COLLABORATION_FILE_UNREADABLE_CHANNEL]: [message: CollaborationFileUnreadableBroadcast];
  [COLLABORATION_FILE_UNWRITABLE_CHANNEL]: [message: CollaborationFileUnwritableBroadcast];
  [COMMAND_FAILED_CHANNEL]: [failure: CommandFailedBroadcast];
  [WORKSPACE_EDIT_PROPOSAL_CHANNEL]: [proposal: WorkspaceEditProposal];
  [CITEPROC_PROBLEMS_CHANNEL]: [problems: CitationResourceProblem[]];
  /** The database that loaded: its path, or CITEPROC_MAIN_DB for the main library. */
  "citeproc-database-updated": [database: string];
  "documents-update": [update: DocumentsUpdateBroadcast];
  "config-provider": [message: ConfigProviderBroadcast];
  "reload-editors": [];
  "css-provider": [message: CSSProviderBroadcast];
  "dictionary-provider": [message: DictionaryProviderBroadcast];
  "assets-provider": [what: AssetsProviderBroadcast];
  "targets-provider": [what: TargetProviderBroadcast];
  "tag-provider": TagProviderBroadcast;
  "update-provider": UpdateProviderBroadcast;
  "lrt-provider": [message: LRTBroadcast];
  "search-provider": [message: SearchProviderBroadcast];
  "menu-provider": [message: MenuProviderMessage];
  "fsal-events": [events: FSALEventPayload[]];
  "fsal-ignore-rules": [sources: IgnoreRuleSources];
  "stats-updated": [stats: Stats];
  "tikz-edit": [event: TikzEditEvent];
  references: [];
  links: [];
  "document-lint-changed": [];
  "document-lint-retried": [];
}

/**
 * T itself when IPC can carry each argument of each channel. A channel with
 * a function or a symbol in its arguments fails the constraint here, at the
 * table, and not at each sender.
 */
type CarriedByIpc<T extends { [C in keyof T]: Cloneable<T[C]> }> = T;

/** The arguments of a message on `channel`, after the event. */
export type IpcBroadcastArgs<C extends keyof IpcBroadcastContracts> =
  CarriedByIpc<IpcBroadcastContracts>[C];

/**
 * The listener signature of window.ipc.on derived from the broadcast table: a
 * listener gets the arguments that the table declares for its channel, and
 * an unknown channel or a listener that annotates another payload is a
 * compile error at the call site. The function that it returns removes the
 * listener.
 */
export interface IpcOn {
  <C extends keyof IpcBroadcastContracts>(
    channel: C,
    listener: (event: undefined, ...args: IpcBroadcastArgs<C>) => void,
  ): () => void;
}

declare global {
  /**
   * The typed surface of window.ipc.on, aliased into the global scope for
   * the ambient Window declaration in source/global.d.ts, as ZettlrIpcInvoke
   * is.
   */
  type ZettlrIpcOn = IpcOn;

  /**
   * The typed surface of window.ipc.invoke, aliased into the global scope so
   * the ambient Window declaration in source/global.d.ts (which cannot use
   * import statements) can reference it. The document operation channels
   * come from @electron-toolkit/typed-ipc over the handler-adjacent
   * DocumentIpcHandlers; the multiplexer and bare channels derive from the
   * provider-owned contract maps composed above.
   */
  type ZettlrIpcInvoke = IpcEmitter<DocumentIpcHandlers>["invoke"] & IpcInvoke;
}

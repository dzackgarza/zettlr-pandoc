import type { IpcEmitter } from "@electron-toolkit/typed-ipc/renderer";
import type {
  MathJaxMacrosIPCResponse,
  MathJaxPairedDelimitersIPCResponse,
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

export interface IpcFixedChannelContracts {
  "request-files": RequestFilesIPCContract;
  "close-all": CloseAllIPCContract;
}

export interface IpcBareChannelContracts {
  i18n: I18nIPCResponse;
  "mathjax-macros": MathJaxMacrosIPCResponse;
  "mathjax-paired-delimiters": MathJaxPairedDelimitersIPCResponse;
  "tex-macro-commands": TexMacroCommandsIPCResponse;
  "tikz-completion-commands": TikzCompletionIPCResponse;
  "request-dir": RequestDirIPCResponse;
  "paste-image-retrieve-data": PasteImageRetrieveDataIPCResponse;
}

export type IpcRequestOf<E> = E extends { request: infer R } ? R : never;

export type IpcResponseOf<E> = E extends { response: infer R } ? R : never;

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

type CarriedByIpc<T extends { [C in keyof T]: Cloneable<T[C]> }> = T;

export type IpcBroadcastArgs<C extends keyof IpcBroadcastContracts> =
  CarriedByIpc<IpcBroadcastContracts>[C];

export interface IpcOn {
  <C extends keyof IpcBroadcastContracts>(
    channel: C,
    listener: (event: undefined, ...args: IpcBroadcastArgs<C>) => void,
  ): () => void;
}

declare global {
  type ZettlrIpcOn = IpcOn;

  type ZettlrIpcInvoke = IpcEmitter<DocumentIpcHandlers>["invoke"] & IpcInvoke;
}

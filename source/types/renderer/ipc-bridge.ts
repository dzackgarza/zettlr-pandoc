/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer IPC invoke composition
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The typed surface of window.ipc.invoke, composed from
 *                  provider-owned contracts. Nothing is declared here: every
 *                  request and response type lives beside the ipcMain
 *                  handler that implements it (for modules with pre-existing
 *                  whole-file lint debt, in a small ipc-contract.ts in the
 *                  same module directory). This file only assembles those
 *                  owner-exported maps into a channel table and derives the
 *                  invoke signature from it.
 *
 * END HEADER
 */

import type { IpcEmitter } from "@electron-toolkit/typed-ipc/renderer";
import type { MathJaxMacrosIPCResponse } from "source/app/lifecycle";
import type { AppearanceProviderIPCContract } from "source/app/service-providers/appearance/ipc-contract";
import type { AssetsProviderIPCContract } from "source/app/service-providers/assets";
import type { CiteprocIPCContract } from "source/app/service-providers/citeproc";
import type { ApplicationIPCContract } from "source/app/service-providers/commands";
import type { PasteImageRetrieveDataIPCResponse } from "source/app/service-providers/commands/save-image-from-clipboard";
import type { OnboardingIPCContract } from "source/app/service-providers/config/onboarding-window";
import type { CSSProviderIPCContract } from "source/app/service-providers/css/ipc-contract";
import type { DictionaryProviderIPCContract } from "source/app/service-providers/dictionary/ipc-contract";
import type {
  DocumentAuthorityIPCContract,
  DocumentIpcHandlers,
  DocumentManagerIPCContract,
} from "source/app/service-providers/documents";
import type { FsalIPCContract } from "source/app/service-providers/fsal/ipc-contract";
import type { LinkProviderIPCContract } from "source/app/service-providers/links/ipc-contract";
import type { LogProviderIPCContract } from "source/app/service-providers/log/ipc-contract";
import type { LRTIPCContract } from "source/app/service-providers/long-running-tasks";
import type { MenuProviderIPCContract } from "source/app/service-providers/menu/ipc-contract";
import type { ReferenceProviderIPCContract } from "source/app/service-providers/references";
import type { SearchProviderIPCContract } from "source/app/service-providers/search";
import type { StatsProviderIPCContract } from "source/app/service-providers/stats/ipc-contract";
import type { TagProviderIPCContract } from "source/app/service-providers/tags/ipc-contract";
import type { TargetProviderIPCContract } from "source/app/service-providers/targets/ipc-contract";
import type { UpdateProviderIPCContract } from "source/app/service-providers/updates/ipc-contract";
import type {
  CloseAllIPCContract,
  RequestDirIPCResponse,
  RequestFilesIPCContract,
} from "source/app/service-providers/windows";
import type { I18nIPCResponse } from "source/common/i18n-main";

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
 * payload is a compile error at the call site. The R parameter lets a call
 * site narrow a response to a subtype it can prove via a plain annotation —
 * never widen past the owner's contract, and never produce any.
 */
export interface IpcInvoke {
  <
    C extends keyof IpcInvokeContracts,
    K extends keyof IpcInvokeContracts[C] & string,
    R extends IpcResponseOf<IpcInvokeContracts[C][K]> = IpcResponseOf<IpcInvokeContracts[C][K]>,
  >(
    channel: C,
    message: { command: K } & IpcRequestOf<IpcInvokeContracts[C][K]>,
  ): Promise<R>;
  <C extends keyof IpcFixedChannelContracts>(
    channel: C,
    message: IpcFixedChannelContracts[C]["request"],
  ): Promise<IpcFixedChannelContracts[C]["response"]>;
  <C extends keyof IpcBareChannelContracts>(channel: C): Promise<IpcBareChannelContracts[C]>;
}

declare global {
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

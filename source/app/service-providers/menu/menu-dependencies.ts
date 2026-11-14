import type CommandProvider from "@providers/commands";
import type { ConfigValue } from "@providers/config/get-config-template";
import type DocumentManager from "@providers/documents";
import type LogProvider from "@providers/log";
import type RecentDocumentsProvider from "@providers/recent-docs";
import type WindowProvider from "@providers/windows";

export type MenuLogger = Pick<LogProvider, "error">;
export type MenuRecentDocuments = Pick<RecentDocumentsProvider, "get" | "clear">;
export type MenuCommands = Pick<CommandProvider, "run">;
export type MenuWindows = Pick<
  WindowProvider,
  | "getFirstMainWindow"
  | "showAboutWindow"
  | "showDefaultsWindow"
  | "showErrorMessage"
  | "showLogWindow"
  | "showPreferences"
  | "showTagManager"
>;
export type MenuDocuments = Pick<DocumentManager, "newWindow" | "openFile">;

/** The settings that the menu reads by key. */
export type MenuConfigKey = "system.zoomBehavior" | "darkMode" | "fileMeta" | "debug";
/** The settings that the menu changes. */
type MenuConfigWriteKey = "darkMode" | "fileMeta" | "editor.fontSize";

/**
 * The application menu reads a handful of configuration fields and can toggle
 * two of them. Keeping that capability explicit lets callers provide the real
 * config provider without making menu construction depend on every private
 * detail of that provider.
 */
export interface MenuConfig {
  get: {
    (): {
      editor: {
        fontSize: number;
        snippetsFile: string;
        quickTexFile: string;
      };
    };
    <K extends MenuConfigKey>(key: K): ConfigValue<K>;
  };
  set: <K extends MenuConfigWriteKey>(key: K, value: ConfigValue<K>) => void;
}

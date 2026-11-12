/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider test seam
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Boots the REAL DocumentManager over a workspace directory,
 *                  with the FSAL reading and writing the real files. The
 *                  descriptor of a file is the one that the parser of the
 *                  FSAL makes. A message for a window goes through the
 *                  addressing of the window provider to the windows of
 *                  the harness. A spec must import the headless Electron
 *                  harness before this.
 *
 * END HEADER
 */

import { BrowserWindow } from "electron";
import { readFileSync, statSync, unlinkSync } from "fs";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import type CiteprocProvider from "source/app/service-providers/citeproc";
import FileDelete from "source/app/service-providers/commands/file-delete";
import ConfigProvider from "source/app/service-providers/config";
import DocumentManager from "source/app/service-providers/documents";
import FSAL from "source/app/service-providers/fsal";
import { parse as parseMarkdownFile } from "source/app/service-providers/fsal/fsal-file";
import getMarkdownFileParser from "source/app/service-providers/fsal/util/file-parser";
import { writeTextFile } from "source/app/service-providers/fsal/util/write-text-file";
import LogProvider from "source/app/service-providers/log";
import askSaveChanges from "source/app/service-providers/windows/dialog/ask-save-changes";
import saveFileDialog from "source/app/service-providers/windows/dialog/save-dialog";
import tellMainWindows from "source/app/service-providers/windows/tell-main-windows";
import type { AnyDescriptor } from "source/types/common/fsal";
import type { IpcValue } from "source/types/common/ipc";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

type WatchdogListener = (event: string, filePath: string) => void;
let watchdogListener: WatchdogListener | undefined;

/** Reports a disk event to the booted manager, as the FSAL watchdog does. */
export function emitWatchdogEvent(event: "add" | "change" | "unlink", filePath: string): void {
  if (watchdogListener === undefined) {
    throw new Error("No DocumentManager subscribed to the watchdog");
  }
  watchdogListener(event, filePath);
}

/** The main window of each window id of a provider, while the window is open. */
const mainWindows = new Map<string, BrowserWindow>();

/**
 * Opens the main window of the window `windowId` of a provider, as the
 * window provider does for each window of the documents provider. Without
 * it, a message for that window goes to the first open window: the main
 * window that the author used last.
 */
export function openMainWindow(windowId: string): BrowserWindow {
  const window = new BrowserWindow();
  mainWindows.set(windowId, window);
  return window;
}

/** The providers of the application that a spec gives to the DocumentManager. */
interface DocumentManagerParts {
  /** Gets the bibliographies of the documents and of the Quarto books. */
  citeproc: Pick<CiteprocProvider, "synchronizeDatabases">;
  /** The descriptors of the workspace, as `FSAL.getAllLoadedDescriptors` gives them. */
  loadedDescriptors?: () => Promise<AnyDescriptor[]>;
  /** The open workspaces of the configuration, when `root` is not the only one. */
  workspaces?: string[];
}

/**
 * A booted DocumentManager whose only workspace is `root`, or whose workspaces
 * are `parts.workspaces`. Without `parts`, no citation provider gets the
 * bibliographies of its documents.
 */
export async function bootDocumentManager(
  root: string,
  parts: DocumentManagerParts = {
    citeproc: { synchronizeDatabases: async (_libraries: string[]) => {} },
  },
): Promise<DocumentManager> {
  const watcher = {
    on: (_name: string, listener: WatchdogListener) => {
      watchdogListener = listener;
    },
    getWatched: () => ({}),
    watchPath: (_filePath: string) => {},
    unwatchPath: (_filePath: string) => {},
    shutdown: async () => {},
  };
  const log = new LogProvider();
  const settings = {
    app: { openFiles: [], openWorkspaces: parts.workspaces ?? [root] },
    editor: { autoSave: "off" as const },
    system: { avoidNewTabs: false },
    appLang: "en-US",
    files: {
      images: { openWith: "zettlr" as const },
      pdf: { openWith: "zettlr" as const },
    },
    alwaysReloadFiles: false,
  };
  const config = {
    // The directory that the last file dialog showed is the one keyed value.
    get: (key?: string) => (key === "dialogPaths.askFileDialog" ? root : settings),
    addPath: (_filePath: string) => false,
    set: (_key: string, _value: unknown) => {},
  };
  // The real provider with the values of the configuration template, for the
  // real file dialog. It is not booted: a boot reads the configuration file
  // and opens the onboarding window.
  const dialogConfig = new ConfigProvider(
    log,
    [path.resolve("static", "lang")],
    unexpectedStoreWriteFailure,
  );
  dialogConfig.set("dialogPaths.askFileDialog", root);
  // The descriptor of a Markdown file, read from the disk at each request.
  const parseDocument = getMarkdownFileParser(dialogConfig.get().zkn.idRE);
  const descriptorFor = async (filePath: string) =>
    await parseMarkdownFile(filePath, null, parseDocument);
  const appSeam = {
    log,
    config,
    fsal: {
      getWatchdog: () => watcher,
      getDescriptorForAnySupportedFile: descriptorFor,
      loadAnySupportedFile: async (filePath: string) => readFileSync(filePath, "utf-8"),
      getDescriptorFor: descriptorFor,
      getFilesystemMetadata: async (filePath: string) => ({ modtime: statSync(filePath).mtimeMs }),
      testAccess: FSAL.prototype.testAccess,
      writeTextFile,
      getAllLoadedDescriptors: parts.loadedDescriptors,
    },
    citeproc: parts.citeproc,
    recentDocs: {
      add: (_filePath: string) => {},
      markEdited: (_filePath: string) => {},
    },
    stats: {
      updateCounts: (_words: number, _characters: number) => {},
    },
    references: {
      reportAuthorityBuffer: (_filePath: string) => {},
      dropAuthorityBuffer: (_filePath: string) => {},
    },
    windows: {
      // The real prompt, with no window to attach it to.
      askSaveChanges: async (detail?: string) => await askSaveChanges(null, detail),
      // The real file dialog, with no window to attach it to.
      saveFile: async (filePath: string) => await saveFileDialog(log, dialogConfig, null, filePath),
      // The real addressing, over the windows that the spec has open.
      tellMainWindows: (windowIds: readonly string[], channel: string, payload: IpcValue) => {
        const open = BrowserWindow.getAllWindows();
        tellMainWindows(
          windowIds
            .map((windowId) => mainWindows.get(windowId))
            .filter((window) => window !== undefined && open.includes(window)),
          open[0],
          channel,
          payload,
        );
      },
    },
  };

  const provider = new DocumentManager(appSeam as unknown as AppServiceContainer);
  await provider.boot();
  return provider;
}

/**
 * The real file-delete command over `provider`. Its delete removes the file
 * from the disk, with no trash.
 */
export function fileDeleteCommand(provider: DocumentManager): FileDelete {
  return new FileDelete({
    log: new LogProvider(),
    documents: provider,
    fsal: {
      removeFile: async (filePath: string) => {
        unlinkSync(filePath);
      },
    },
  });
}

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
 *                  with the FSAL reading and writing the real files. A spec
 *                  must import the headless Electron harness before this.
 *
 * END HEADER
 */

import { readFileSync, statSync, unlinkSync } from "fs";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import type CiteprocProvider from "source/app/service-providers/citeproc";
import FileDelete from "source/app/service-providers/commands/file-delete";
import ConfigProvider from "source/app/service-providers/config";
import DocumentManager from "source/app/service-providers/documents";
import FSAL from "source/app/service-providers/fsal";
import { writeTextFile } from "source/app/service-providers/fsal/util/write-text-file";
import LogProvider from "source/app/service-providers/log";
import askSaveChanges from "source/app/service-providers/windows/dialog/ask-save-changes";
import saveFileDialog from "source/app/service-providers/windows/dialog/save-dialog";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import extractYamlFrontmatter from "source/common/util/extract-yaml-frontmatter";
import type { AnyDescriptor, MDFileDescriptor } from "source/types/common/fsal";

function descriptorFor(filePath: string): MDFileDescriptor {
  const content = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);
  return {
    dir: path.dirname(filePath),
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath),
    size: stat.size,
    id: "",
    tags: [],
    links: [],
    citekeys: [],
    bom: "",
    type: "file",
    wordCount: 0,
    charCount: content.length,
    modtime: stat.mtimeMs,
    creationtime: stat.birthtimeMs,
    linefeed: "\n",
    firstHeading: null,
    yamlTitle: undefined,
    aliases: [],
    frontmatter: extractYamlFrontmatter(content).frontmatter,
    references: extractReferences(filePath, content),
  };
}

type WatchdogListener = (event: string, filePath: string) => void;
let watchdogListener: WatchdogListener | undefined;

/** Reports a disk event to the booted manager, as the FSAL watchdog does. */
export function emitWatchdogEvent(event: "add" | "change" | "unlink", filePath: string): void {
  if (watchdogListener === undefined) {
    throw new Error("No DocumentManager subscribed to the watchdog");
  }
  watchdogListener(event, filePath);
}

/** The providers of the application that a spec gives to the DocumentManager. */
interface DocumentManagerParts {
  /** Gets the bibliographies of the documents and of the Quarto books. */
  citeproc: Pick<CiteprocProvider, "synchronizeDatabases">;
  /** The descriptors of the workspace, as `FSAL.getAllLoadedDescriptors` gives them. */
  loadedDescriptors?: () => Promise<AnyDescriptor[]>;
}

/**
 * A booted DocumentManager whose only workspace is `root`. Without `parts`,
 * no citation provider gets the bibliographies of its documents.
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
    app: { openFiles: [], openWorkspaces: [root] },
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
  const dialogConfig = new ConfigProvider(log, [path.resolve("static", "lang")]);
  dialogConfig.set("dialogPaths.askFileDialog", root);
  const appSeam = {
    log,
    config,
    fsal: {
      getWatchdog: () => watcher,
      getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
      loadAnySupportedFile: async (filePath: string) => readFileSync(filePath, "utf-8"),
      getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
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

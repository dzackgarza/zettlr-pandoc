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

import { readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import type { MDFileDescriptor } from "source/types/common/fsal";

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
    frontmatter: null,
    references: extractReferences(filePath, content),
  };
}

type WatchdogListener = (event: string, filePath: string) => void;
let watchdogListener: WatchdogListener | undefined;

/** Reports a disk event to the booted manager, as the FSAL watchdog does. */
export function emitWatchdogEvent(event: "change" | "unlink", filePath: string): void {
  if (watchdogListener === undefined) {
    throw new Error("No DocumentManager subscribed to the watchdog");
  }
  watchdogListener(event, filePath);
}

/** A booted DocumentManager whose only workspace is `root`. */
export async function bootDocumentManager(root: string): Promise<DocumentManager> {
  const watcher = {
    on: (_name: string, listener: WatchdogListener) => {
      watchdogListener = listener;
    },
    getWatched: () => ({}),
    watchPath: (_filePath: string) => {},
    unwatchPath: (_filePath: string) => {},
    shutdown: async () => {},
  };
  const appSeam = {
    log: new LogProvider(),
    config: {
      get: () => ({
        app: { openFiles: [], openWorkspaces: [root] },
        editor: { autoSave: "off" as const },
        system: { avoidNewTabs: false },
        appLang: "en-US",
        files: {
          images: { openWith: "zettlr" as const },
          pdf: { openWith: "zettlr" as const },
        },
        alwaysReloadFiles: false,
      }),
      addPath: (_filePath: string) => false,
      set: (_key: string, _value: unknown) => {},
    },
    fsal: {
      getWatchdog: () => watcher,
      getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
      loadAnySupportedFile: async (filePath: string) => readFileSync(filePath, "utf-8"),
      getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
      getFilesystemMetadata: async (filePath: string) => ({ modtime: statSync(filePath).mtimeMs }),
      testAccess: async (_filePath: string) => true,
      writeTextFile: async (filePath: string, content: string) => {
        writeFileSync(filePath, content, "utf-8");
      },
    },
    citeproc: {
      synchronizeDatabases: async (_libraries: string[]) => {},
    },
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
  };

  const provider = new DocumentManager(appSeam as unknown as AppServiceContainer);
  await provider.boot();
  return provider;
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recent files specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager against the REAL
 *                  RecentDocumentsProvider. Opening a file in a pane puts
 *                  it at the top of the recently opened list; saving one
 *                  puts it at the top of the recently edited list. Each
 *                  list keeps one entry per file, at most the configured
 *                  number of files, and survives a restart of the provider.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import RecentDocumentsProvider from "source/app/service-providers/recent-docs";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import type { MDFileDescriptor } from "source/types/common/fsal";
import { userData } from "./headless-electron-harness.cjs";

const RECENT_FILES_LIMIT = 3;

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

describe("Recent files", function () {
  let root: string;
  let files: Record<"a" | "b" | "c" | "d", string>;
  let recentDocs: RecentDocumentsProvider;
  let provider: DocumentManager;
  let windowId: string;
  let leafId: string;

  const log = new LogProvider();
  const config = {
    get: () => ({
      app: { openFiles: [], openWorkspaces: [root] },
      editor: { autoSave: "off" as const, formatOnSave: false },
      system: { avoidNewTabs: false },
      ui: { recentFilesLimit: RECENT_FILES_LIMIT },
      appLang: "en-US",
      files: {
        images: { openWith: "zettlr" as const },
        pdf: { openWith: "zettlr" as const },
      },
      alwaysReloadFiles: false,
    }),
    addPath: (_filePath: string) => false,
    set: (_key: string, _value: unknown) => {},
  };

  async function bootRecentDocs(): Promise<RecentDocumentsProvider> {
    const booted = new RecentDocumentsProvider(log, config);
    await booted.boot();
    return booted;
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-recent-files-"));
    files = {
      a: path.join(root, "A.md"),
      b: path.join(root, "B.md"),
      c: path.join(root, "C.md"),
      d: path.join(root, "D.md"),
    };
    for (const [name, filePath] of Object.entries(files)) {
      writeFileSync(filePath, `# ${name}\n`, "utf-8");
    }
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(path.join(userData, "recent-files.json"), { force: true });

    const watcher = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_filePath: string) => {},
      unwatchPath: (_filePath: string) => {},
      shutdown: async () => {},
    };
    recentDocs = await bootRecentDocs();
    const appSeam = {
      log,
      config,
      fsal: {
        getWatchdog: () => watcher,
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => readFileSync(filePath, "utf-8"),
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
        getFilesystemMetadata: async (filePath: string) => ({
          modtime: statSync(filePath).mtimeMs,
        }),
        testAccess: async (_filePath: string) => true,
        writeTextFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, "utf-8");
        },
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {},
      },
      recentDocs,
      stats: {
        updateCounts: (_words: number, _characters: number) => {},
      },
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {},
      },
    };

    provider = new DocumentManager(appSeam as unknown as AppServiceContainer);
    await provider.boot();
    windowId = provider.windowKeys()[0];
    leafId = provider.leafIds(windowId)[0];
  });

  afterEach(async function () {
    await provider.shutdown();
    await recentDocs.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  async function open(filePath: string): Promise<void> {
    assert.equal(await provider.openFile(windowId, leafId, filePath), true);
  }

  it("lists opened files newest first, one entry per file, up to the configured cap, across a restart", async function () {
    await open(files.a);
    await open(files.b);
    await open(files.c);
    await open(files.a);
    assert.deepEqual(recentDocs.get(), [files.a, files.c, files.b]);

    await open(files.d);
    assert.deepEqual(recentDocs.get(), [files.d, files.a, files.c]);
    assert.deepEqual(recentDocs.getEdited(), []);

    await recentDocs.shutdown();
    const restarted = await bootRecentDocs();
    assert.deepEqual(restarted.get(), [files.d, files.a, files.c]);
    await restarted.shutdown();
  });

  it("lists a file as edited when a save writes it, newest save first", async function () {
    await open(files.a);
    await open(files.b);
    // The editor loads the buffer of the document it shows.
    await provider.getDocument(files.a);
    await provider.getDocument(files.b);
    for (const filePath of [files.a, files.b, files.a]) {
      await provider.applyWorkspaceTextEdits([
        { documentPath: filePath, range: { from: 0, to: 0 }, insert: "Draft: " },
      ]);
      assert.equal((await provider.saveFile(filePath)).ok, true);
    }
    assert.deepEqual(recentDocs.getEdited(), [files.a, files.b]);
    assert.equal(readFileSync(files.a, "utf-8"), "Draft: Draft: # a\n");

    await recentDocs.shutdown();
    const restarted = await bootRecentDocs();
    assert.deepEqual(restarted.getEdited(), [files.a, files.b]);
    await restarted.shutdown();
  });

  it("leaves out a file that no longer exists", async function () {
    await open(files.a);
    await open(files.b);
    await rm(files.a);
    assert.deepEqual(recentDocs.get(), [files.b]);
  });
});

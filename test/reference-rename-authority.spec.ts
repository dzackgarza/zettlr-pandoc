/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace rename document-authority boundary specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves that workspace reference edits cross the real
 *                  ReferenceProvider -> DocumentManager authority boundary.
 *                  Every open touched document is changed in the central
 *                  authority before commit reports success; immediate undo
 *                  is therefore fenced against acknowledged authority text
 *                  rather than against transactions held by one renderer.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import EventEmitter from "events";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import DocumentManager from "source/app/service-providers/documents";
import { parse as parseDirectory } from "source/app/service-providers/fsal/fsal-directory";
import LogProvider from "source/app/service-providers/log";
import ReferenceProvider from "source/app/service-providers/references";
import type { ReferenceRenamePreview } from "source/common/pandoc-util/compute-reference-edits";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import type { MDFileDescriptor } from "source/types/common/fsal";
import { userData } from "./headless-electron-harness.cjs";

const OLD_KEY = "thm:authority-owned";
const NEW_KEY = "thm:authority-acknowledged";
const DEFINITION_SOURCE = [
  "# Authority boundary",
  "",
  "::: {.theorem #thm:authority-owned}",
  "The authority owns this live definition.",
  ":::",
  "",
].join("\n");
const OCCURRENCE_SOURCE = [
  "# Consumer",
  "",
  "The live consumer cites @thm:authority-owned before saving.",
  "",
].join("\n");
const RENAMED_DEFINITION_SOURCE = DEFINITION_SOURCE.replace(OLD_KEY, NEW_KEY);
const RENAMED_OCCURRENCE_SOURCE = OCCURRENCE_SOURCE.replace(OLD_KEY, NEW_KEY);

/** Build the real markdown descriptor consumed by both owned providers. */
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
    fileLinks: [],
    citekeys: [],
    bom: "",
    type: "file",
    wordCount: 0,
    charCount: content.length,
    modtime: stat.mtimeMs,
    creationtime: stat.birthtimeMs,
    linefeed: "\n",
    firstHeading: null,
    firstSentence: null,
    yamlTitle: undefined,
    aliases: [],
    frontmatter: null,
    references: extractReferences(filePath, content),
  };
}

interface ScratchBoundary {
  root: string;
  definitionPath: string;
  occurrencePath: string;
  documents: DocumentManager;
  references: ReferenceProvider;
  fsalEvents: EventEmitter;
}

async function createScratchBoundary(): Promise<ScratchBoundary> {
  const root = await mkdtemp(path.join(tmpdir(), "zettlr-reference-authority-"));
  const definitionPath = path.join(root, "Definition.md");
  const occurrencePath = path.join(root, "Occurrence.md");
  writeFileSync(definitionPath, DEFINITION_SOURCE, "utf-8");
  writeFileSync(occurrencePath, OCCURRENCE_SOURCE, "utf-8");

  mkdirSync(userData, { recursive: true });
  mkdirSync(path.join(userData, "logs"), { recursive: true });

  const fsalEvents = new EventEmitter();
  const watcher = {
    on: () => {},
    getWatched: () => ({}),
    watchPath: (_filePath: string) => {},
    unwatchPath: (_filePath: string) => {},
    shutdown: async () => {},
  };
  let references: ReferenceProvider;
  const app = {
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
      // The folders of the documents, as the FSAL reads them from disk.
      getAnyDirectoryDescriptor: async (dirPath: string) => await parseDirectory(dirPath),
      getFilesystemMetadata: async (filePath: string) => ({ modtime: statSync(filePath).mtimeMs }),
      readDirectoryRecursively: async (_workspacePath: string) => ({
        paths: [definitionPath, occurrencePath],
        notListed: [],
      }),
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
    windows: {
      askSaveChanges: async (_detail?: string) => ({ response: 0, checkboxChecked: false }),
      getFirstMainWindow: () => undefined,
      // The spec has no main window, so no window gets a message.
      tellMainWindows: (
        _windowIds: readonly string[],
        _channel: string,
        ..._args: readonly unknown[]
      ) => {},
      getMainWindowKey: (_window: unknown) => "",
      // No operation of this spec asks the author for a file.
      saveFile: async (_filePath: string): Promise<string | undefined> => {
        throw new Error("This spec shows no save dialog");
      },
      // No operation of this spec opens a file with the desktop.
      showErrorMessage: (_title: string, _message: string, _contents?: string) => {
        throw new Error("This spec opens no file with the desktop");
      },
    },
    references: {
      reportAuthorityBuffer: (filePath: string, immediate?: boolean) => {
        references.reportAuthorityBuffer(filePath, immediate);
      },
      dropAuthorityBuffer: (filePath: string) => {
        references.dropAuthorityBuffer(filePath);
      },
    },
  };

  const documents = new DocumentManager(app);
  references = new ReferenceProvider(app.log, fsalEvents, documents, () => 500, userData);
  await references.boot();

  fsalEvents.emit("fsal-events", [
    { event: "change", descriptor: descriptorFor(definitionPath) },
    { event: "change", descriptor: descriptorFor(occurrencePath) },
  ]);
  await documents.getDocument(definitionPath);
  await documents.getDocument(occurrencePath);

  return { root, definitionPath, occurrencePath, documents, references, fsalEvents };
}

function acceptedEdit(
  preview: ReferenceRenamePreview,
): Extract<ReferenceRenamePreview, { status: "ok" }>["edit"] {
  assert.equal(preview.status, "ok");
  if (preview.status !== "ok") {
    assert.fail("The representative workspace rename was rejected");
  }
  return preview.edit;
}

/**
 * The keys that the reference state, which a window reads at the broadcast
 * 'references', gives for the definitions and the occurrences of each document.
 */
function servedKeys(
  references: ReferenceProvider,
): Record<string, { definitions: string[]; occurrences: string[] }> {
  const keys: Record<string, { definitions: string[]; occurrences: string[] }> = {};
  for (const snapshot of references.getSnapshot().snapshots) {
    keys[snapshot.documentPath] = {
      definitions: snapshot.definitions.map((definition) => definition.key),
      occurrences: snapshot.occurrences.map((occurrence) => occurrence.key),
    };
  }
  return keys;
}

describe("Workspace reference rename authority application", function () {
  let scratch: ScratchBoundary;

  beforeEach(async function () {
    scratch = await createScratchBoundary();
  });

  afterEach(async function () {
    await scratch.references.shutdown();
    await scratch.documents.shutdown();
    await rm(scratch.root, { recursive: true, force: true });
  });

  it("previews each changed line of each document before anything changes", async function () {
    const preview = await scratch.references.previewRename(OLD_KEY, NEW_KEY);

    assert.equal(preview.status, "ok");
    assert.deepEqual(preview.status === "ok" ? preview.documents : [], [
      {
        documentPath: scratch.definitionPath,
        changes: [
          {
            line: 3,
            before: "::: {.theorem #thm:authority-owned}",
            after: "::: {.theorem #thm:authority-acknowledged}",
          },
        ],
      },
      {
        documentPath: scratch.occurrencePath,
        changes: [
          {
            line: 3,
            before: "The live consumer cites @thm:authority-owned before saving.",
            after: "The live consumer cites @thm:authority-acknowledged before saving.",
          },
        ],
      },
    ]);
    assert.equal(readFileSync(scratch.definitionPath, "utf-8"), DEFINITION_SOURCE);
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.occurrencePath),
      OCCURRENCE_SOURCE,
    );
  });

  it("applies every open touched document in the central authority before reporting success", async function () {
    const edit = acceptedEdit(await scratch.references.previewRename(OLD_KEY, NEW_KEY));

    const outcome = await scratch.references.commitRename(edit);

    assert.equal(outcome.status, "applied");
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
      RENAMED_DEFINITION_SOURCE,
    );
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.occurrencePath),
      RENAMED_OCCURRENCE_SOURCE,
    );
    assert.equal(readFileSync(scratch.definitionPath, "utf-8"), DEFINITION_SOURCE);
    assert.equal(readFileSync(scratch.occurrencePath, "utf-8"), OCCURRENCE_SOURCE);
  });

  it("makes immediate undo safe only after the open-buffer application is acknowledged", async function () {
    const edit = acceptedEdit(await scratch.references.previewRename(OLD_KEY, NEW_KEY));
    const committed = await scratch.references.commitRename(edit);
    assert.equal(committed.status, "applied");

    const undone = await scratch.references.undoRename();

    assert.equal(undone.status, "applied");
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
      DEFINITION_SOURCE,
    );
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.occurrencePath),
      OCCURRENCE_SOURCE,
    );
  });

  it("serves the renamed keys when the commit and the undo announce them (#57)", async function () {
    // A closed document: the FSAL gave its saved snapshot, and the commit
    // writes its file. The watcher of this spec reports no write.
    const closedPath = path.join(scratch.root, "Closed.md");
    writeFileSync(closedPath, OCCURRENCE_SOURCE, "utf-8");
    scratch.fsalEvents.emit("fsal-events", [
      { event: "change", descriptor: descriptorFor(closedPath) },
    ]);
    const edit = acceptedEdit(await scratch.references.previewRename(OLD_KEY, NEW_KEY));

    assert.equal((await scratch.references.commitRename(edit)).status, "applied");
    assert.equal(readFileSync(closedPath, "utf-8"), RENAMED_OCCURRENCE_SOURCE);
    assert.deepEqual(servedKeys(scratch.references), {
      [closedPath]: { definitions: [], occurrences: [NEW_KEY] },
      [scratch.definitionPath]: { definitions: [NEW_KEY], occurrences: [] },
      [scratch.occurrencePath]: { definitions: [], occurrences: [NEW_KEY] },
    });

    assert.equal((await scratch.references.undoRename()).status, "applied");
    assert.deepEqual(servedKeys(scratch.references), {
      [closedPath]: { definitions: [], occurrences: [OLD_KEY] },
      [scratch.definitionPath]: { definitions: [OLD_KEY], occurrences: [] },
      [scratch.occurrencePath]: { definitions: [], occurrences: [OLD_KEY] },
    });
  });

  describe("a rename of open and closed documents (#57)", function () {
    // A closed document beside the two open ones: the transaction writes
    // its file, and the document authority changes the open buffers.
    let closedPath: string;
    const journalFile = path.join(userData, "workspace-edit-journal.json");

    beforeEach(function () {
      closedPath = path.join(scratch.root, "Closed.md");
      writeFileSync(closedPath, OCCURRENCE_SOURCE, "utf-8");
      scratch.fsalEvents.emit("fsal-events", [
        { event: "change", descriptor: descriptorFor(closedPath) },
      ]);
    });

    afterEach(function () {
      chmodSync(closedPath, 0o644);
    });

    it("changes nothing when an open document closes before the authority takes the edit", async function () {
      const edit = acceptedEdit(await scratch.references.previewRename(OLD_KEY, NEW_KEY));

      // The commit reads the open buffers at once and then waits for the
      // file of the closed document; the open document closes in that time.
      const commit = scratch.references.commitRename(edit);
      assert.equal(await scratch.documents.closeFileEverywhere(scratch.occurrencePath), true);

      await assert.rejects(commit, assert.AssertionError);
      assert.equal(readFileSync(closedPath, "utf-8"), OCCURRENCE_SOURCE);
      assert.equal(readFileSync(scratch.occurrencePath, "utf-8"), OCCURRENCE_SOURCE);
      assert.equal(
        scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
        DEFINITION_SOURCE,
      );
      assert.equal(existsSync(journalFile), false, "the transaction leaves no journal");
      assert.deepEqual(await scratch.references.undoRename(), { status: "no-pending-undo" });
    });

    it("gives each open buffer its text again when a closed file cannot be written", async function () {
      const edit = acceptedEdit(await scratch.references.previewRename(OLD_KEY, NEW_KEY));
      chmodSync(closedPath, 0o444);

      await assert.rejects(scratch.references.commitRename(edit), Error);

      assert.equal(readFileSync(closedPath, "utf-8"), OCCURRENCE_SOURCE);
      assert.equal(
        scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
        DEFINITION_SOURCE,
      );
      assert.equal(
        scratch.documents.readMarkdownBufferContent(scratch.occurrencePath),
        OCCURRENCE_SOURCE,
      );
      assert.equal(existsSync(journalFile), false, "the rollback leaves no journal");
      assert.deepEqual(await scratch.references.undoRename(), { status: "no-pending-undo" });
    });

    it("restores no file when an open document closes during the undo, and keeps the undo", async function () {
      const edit = acceptedEdit(await scratch.references.previewRename(OLD_KEY, NEW_KEY));
      assert.equal((await scratch.references.commitRename(edit)).status, "applied");
      assert.equal(readFileSync(closedPath, "utf-8"), RENAMED_OCCURRENCE_SOURCE);

      // The close discards the renamed text of the buffer; its file keeps
      // the text before the rename.
      const undo = scratch.references.undoRename();
      assert.equal(await scratch.documents.closeFileEverywhere(scratch.occurrencePath), true);

      await assert.rejects(undo, assert.AssertionError);
      assert.equal(readFileSync(closedPath, "utf-8"), RENAMED_OCCURRENCE_SOURCE);
      assert.equal(
        scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
        RENAMED_DEFINITION_SOURCE,
      );
      assert.equal(existsSync(journalFile), false, "the rollback leaves no journal");

      // The undo is still pending. Its fence now names the closed document,
      // whose file does not hold the renamed text: the author decides.
      const retry = await scratch.references.undoRename();
      assert.equal(retry.status, "conflict");
      assert.equal(
        retry.status === "conflict" ? retry.conflict.documentPath : "",
        scratch.occurrencePath,
      );
      assert.equal(readFileSync(closedPath, "utf-8"), RENAMED_OCCURRENCE_SOURCE);
    });
  });
});

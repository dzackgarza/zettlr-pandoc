/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unreadable collaboration sidecar specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The annotations and the review of a closed document are in
 *                  one file of the application data. A file that this version
 *                  of the application cannot read (written by a later
 *                  version, or damaged) must not hide the state of the other
 *                  documents, and the author must be able to act on it. This
 *                  spec drives the real documents provider: the workspace
 *                  listing names the unreadable file and still lists the
 *                  other documents, the author can move the file aside, the
 *                  window is told when such a document opens, no new state of
 *                  that document replaces the file, and a move of a directory
 *                  still carries the state of its documents (#178).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { BrowserWindow } from "electron";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { collaborationSidecarFilePath } from "source/app/service-providers/documents/collaboration-sidecar-store";
import {
  COLLABORATION_FILE_UNREADABLE_CHANNEL,
  type CollaborationFileUnreadableBroadcast,
  type WorkspaceCollaborationListing,
} from "source/types/common/document-collaboration";
import { bootDocumentManager } from "./documents-provider-seam";
import {
  ipcMainHandlers,
  messageBoxes,
  sentMessagesFor,
  userData,
} from "./headless-electron-harness.cjs";

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

const GENUS = "A genus holds finitely many isometry classes.\n";
const LATTICE = "An even unimodular lattice has a rank that 8 divides.\n";
const SIDECARS = path.join(userData, "review-sidecars");
// The second button of the close prompt: do not save the unsaved text.
const DISCARD = 1;

describe("A collaboration sidecar that the application cannot read", function () {
  let root: string;
  let genusPath: string;
  let latticePath: string;
  let provider: DocumentManager;
  let windowId: string;
  let window: BrowserWindow;
  let unreadableFile: string;
  let unreadableBytes: string;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-unreadable-sidecar-"));
    genusPath = path.join(root, "genus.md");
    latticePath = path.join(root, "forms", "lattice.md");
    mkdirSync(path.dirname(latticePath));
    writeFileSync(genusPath, GENUS, "utf-8");
    writeFileSync(latticePath, LATTICE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    mkdirSync(SIDECARS);
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;

    provider = await bootDocumentManager(root);
    windowId = provider.windowKeys()[0];
    window = new BrowserWindow();

    await annotateAndClose(genusPath, "genus");
    await annotateAndClose(latticePath, "lattice");

    // The sidecar of genus.md as a later version of the application writes
    // it: this version has no reader for that schema.
    unreadableFile = collaborationSidecarFilePath(SIDECARS, genusPath);
    const written: { version: number } = JSON.parse(readFileSync(unreadableFile, "utf-8"));
    unreadableBytes = JSON.stringify({ ...written, version: written.version + 1 });
    writeFileSync(unreadableFile, unreadableBytes, "utf-8");
  });

  afterEach(async function () {
    window.close();
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  function pane(): string {
    const leaves = provider.leafIds(windowId);
    assert.equal(leaves.length, 1, "the window has one pane");
    return leaves[0];
  }

  /** Gives the document one annotation on `word` and closes it: its state is in a sidecar. */
  async function annotateAndClose(filePath: string, word: string): Promise<void> {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
    const id = provider.getDocumentId(filePath);
    assert.ok(id !== undefined, "a loaded document has an id");
    const from = readFileSync(filePath, "utf-8").indexOf(word);
    const created = await provider.createAnnotation(
      id,
      "owner",
      from,
      from + word.length,
      "State the indefinite case.",
      provider.annotationQueries.getAnnotations(id).generation,
    );
    if ("ok" in created) {
      assert.fail(`The annotation was refused: ${created.code}`);
    }
    assert.equal(await provider.closeFileEverywhere(filePath), true);
  }

  async function invoke(command: string, payload: unknown): Promise<unknown> {
    const handler = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(handler !== undefined, "the documents-provider handler is registered");
    return await handler(undefined, { command, payload });
  }

  /** The listing that the Annotations view reads. */
  async function workspaceListing(paths: string[]): Promise<WorkspaceCollaborationListing> {
    return (await invoke("get-workspace-collaboration-sessions", {
      paths,
    })) as WorkspaceCollaborationListing;
  }

  it("lists the other documents and names the file", async function () {
    const listing = await workspaceListing([genusPath, latticePath]);

    assert.deepEqual(
      listing.sessions.map((session) => [session.documentPath, session.annotations.items.length]),
      [[latticePath, 1]],
      "the document with a readable sidecar is listed with its annotation",
    );
    assert.deepEqual(
      listing.unreadable.map((entry) => [entry.file, entry.documentPath]),
      [[unreadableFile, genusPath]],
      "the listing names the file that could not be read, and its document",
    );
    assert.equal(readFileSync(unreadableFile, "utf-8"), unreadableBytes, "the file is unchanged");
  });

  it("moves the file aside when the author asks, and keeps its bytes", async function () {
    await invoke("set-aside-collaboration-sidecar", { file: unreadableFile });

    const listing = await workspaceListing([genusPath, latticePath]);
    assert.deepEqual(listing.unreadable, [], "no unreadable file is left in the listing");
    assert.deepEqual(
      listing.sessions.map((session) => session.documentPath),
      [latticePath],
    );
    const kept = readdirSync(SIDECARS)
      .filter((name) => !name.endsWith(".json"))
      .map((name) => readFileSync(path.join(SIDECARS, name), "utf-8"));
    assert.deepEqual(kept, [unreadableBytes], "the bytes of the file are kept beside the sidecars");

    // The document takes new annotations, and they are listed.
    await annotateAndClose(genusPath, "isometry");
    assert.deepEqual(
      (await workspaceListing([genusPath, latticePath])).sessions
        .map((session) => session.documentPath)
        .sort(),
      [genusPath, latticePath].sort(),
    );
  });

  it("tells the window when the document of the file opens", async function () {
    await provider.getDocument(genusPath);
    assert.equal(await provider.openFile(windowId, pane(), genusPath), true);

    const told = sentMessagesFor(window)
      .filter(([channel]) => channel === COLLABORATION_FILE_UNREADABLE_CHANNEL)
      .map(([, payload]) => payload as CollaborationFileUnreadableBroadcast);
    assert.deepEqual(
      told.map((entry) => [entry.filePath, entry.file]),
      [[genusPath, unreadableFile]],
      "the window is told one time which document opened without its state, and which file holds it",
    );
    assert.equal(readFileSync(unreadableFile, "utf-8"), unreadableBytes, "the file is unchanged");
  });

  it("refuses a new annotation on the open document, and keeps the file", async function () {
    await provider.getDocument(genusPath);
    assert.equal(await provider.openFile(windowId, pane(), genusPath), true);
    const id = provider.getDocumentId(genusPath);
    assert.ok(id !== undefined, "a loaded document has an id");
    const from = GENUS.indexOf("isometry");

    const created = await provider.createAnnotation(
      id,
      "owner",
      from,
      from + "isometry".length,
      "Give the bound of the class number.",
      provider.annotationQueries.getAnnotations(id).generation,
    );

    assert.equal(
      "ok" in created ? created.code : "created",
      "PERSISTENCE_FAILED",
      "the annotation is refused: its write would replace the state that the file holds",
    );
    assert.equal(readFileSync(unreadableFile, "utf-8"), unreadableBytes, "the file is unchanged");
  });

  it("closes the open document when the author discards its unsaved text, and keeps the file", async function () {
    await provider.getDocument(genusPath);
    assert.equal(await provider.openFile(windowId, pane(), genusPath), true);
    await provider.applyWorkspaceTextEdits([
      { documentPath: genusPath, range: { from: 0, to: 0 }, insert: "Let p be a prime.\n" },
    ]);
    assert.equal(provider.isModified(genusPath), true, "the document has unsaved text");

    messageBoxes.answer = DISCARD;
    const closed = await provider.closeFile(windowId, pane(), genusPath);

    assert.equal(messageBoxes.shown.length, 1, "the close asks about the unsaved text");
    assert.equal(closed, true, "the document closes: the discarded text has no state in the file");
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
    assert.equal(readFileSync(genusPath, "utf-8"), GENUS, "the discarded text is not on disk");
    assert.equal(readFileSync(unreadableFile, "utf-8"), unreadableBytes, "the file is unchanged");
  });

  it("carries the state of a moved directory's documents", async function () {
    const movedDirectory = path.join(root, "quadratic-forms");
    const movedPath = path.join(movedDirectory, "lattice.md");
    renameSync(path.dirname(latticePath), movedDirectory);

    await provider.hasMovedDir(path.dirname(latticePath), movedDirectory);

    const listing = await workspaceListing([genusPath, movedPath, latticePath]);
    assert.deepEqual(
      listing.sessions.map((session) => [session.documentPath, session.annotations.items.length]),
      [[movedPath, 1]],
      "the annotation of the moved document is at its new path",
    );
  });
});

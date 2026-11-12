/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Collaboration sidecar of no document specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The annotations and the review of a closed document are in
 *                  one file of the application data, keyed by the path of the
 *                  document. That file can outlive its document: the author
 *                  deletes the document, or a move cannot write the file at
 *                  the key of the new path. This spec drives the real
 *                  documents provider: the workspace listing names each such
 *                  file with the path that it belongs to, the author can
 *                  move the file aside, and a file whose document is only
 *                  left out of the listing, or is outside every open
 *                  workspace, is not named (#210).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { BrowserWindow } from "electron";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { collaborationSidecarFilePath } from "source/app/service-providers/documents/collaboration-sidecar-store";
import type { WorkspaceCollaborationListing } from "source/types/common/document-collaboration";
import { bootDocumentManager, fileDeleteCommand } from "./documents-provider-seam";
import { ipcMainHandlers, messageBoxes, userData } from "./headless-electron-harness.cjs";

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

const SOURCE = "An even unimodular lattice has a rank that 8 divides.\n";
const SIDECARS = path.join(userData, "review-sidecars");
// The first button of the delete prompt: delete the file.
const DELETE = 0;

describe("A collaboration sidecar whose document has no file", function () {
  let root: string;
  let outside: string;
  let filePath: string;
  let provider: DocumentManager;
  let windowId: string;
  let window: BrowserWindow;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-sidecar-of-no-document-"));
    outside = await mkdtemp(path.join(tmpdir(), "zettlr-sidecar-outside-"));
    filePath = path.join(root, "note.md");
    writeFileSync(filePath, SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    mkdirSync(SIDECARS);
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;

    // The one open workspace is `root`.
    provider = await bootDocumentManager([root]);
    windowId = provider.windowKeys()[0];
    window = new BrowserWindow();
  });

  afterEach(async function () {
    chmodSync(SIDECARS, 0o700);
    window.close();
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function pane(): string {
    const leaves = provider.leafIds(windowId);
    assert.equal(leaves.length, 1, "the window has one pane");
    return leaves[0];
  }

  /** Gives the document one annotation and closes it: its state is in a sidecar. */
  async function annotateAndClose(documentPath: string): Promise<void> {
    await provider.getDocument(documentPath);
    assert.equal(await provider.openFile(windowId, pane(), documentPath), true);
    const id = provider.getDocumentId(documentPath);
    assert.ok(id !== undefined, "a loaded document has an id");
    const from = SOURCE.indexOf("rank");
    const created = await provider.createAnnotation(
      id,
      "owner",
      from,
      from + "rank".length,
      "State the signature.",
      provider.annotationQueries.getAnnotations(id).generation,
    );
    if ("ok" in created) {
      assert.fail(`The annotation was refused: ${created.code}`);
    }
    assert.equal(await provider.closeFileEverywhere(documentPath), true);
  }

  async function invoke(command: string, payload: unknown): Promise<unknown> {
    const handler = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(handler !== undefined, "the documents-provider handler is registered");
    return await handler(undefined, { command, payload });
  }

  /** The listing that the Annotations view reads for the files of the workspace. */
  async function workspaceListing(paths: string[]): Promise<WorkspaceCollaborationListing> {
    return (await invoke("get-workspace-collaboration-sessions", {
      paths,
    })) as WorkspaceCollaborationListing;
  }

  /** The file and the document path of each sidecar that the listing names as of no document. */
  async function sidecarsOfNoDocument(paths: string[]): Promise<Array<[string, string]>> {
    return (await workspaceListing(paths)).ownerless.map((entry) => [
      entry.file,
      entry.documentPath,
    ]);
  }

  it("names the sidecar of a deleted document, and moves it aside when the author asks", async function () {
    await annotateAndClose(filePath);
    const sidecarFile = collaborationSidecarFilePath(SIDECARS, filePath);
    const bytes = readFileSync(sidecarFile, "utf-8");

    messageBoxes.answer = DELETE;
    assert.equal(await fileDeleteCommand(provider).run("file-delete", { path: filePath }), true);

    // The workspace has no file now.
    assert.deepEqual(await sidecarsOfNoDocument([]), [[sidecarFile, filePath]]);

    await invoke("set-aside-collaboration-sidecar", { file: sidecarFile });

    assert.deepEqual(await sidecarsOfNoDocument([]), [], "the listing names no file");
    assert.deepEqual(
      readdirSync(SIDECARS).map((name) => readFileSync(path.join(SIDECARS, name), "utf-8")),
      [bytes],
      "the bytes of the file are kept beside the sidecars",
    );
    // A new document at the path does not get the state of the deleted one.
    writeFileSync(filePath, SOURCE, "utf-8");
    assert.deepEqual((await workspaceListing([filePath])).sessions, []);
  });

  it("names the sidecar that a move of its document could not carry", async function () {
    await annotateAndClose(filePath);
    const sidecarFile = collaborationSidecarFilePath(SIDECARS, filePath);
    const movedPath = path.join(root, "lattices.md");

    // The directory of the sidecars takes no new file: the state cannot go
    // to the key of the new path.
    chmodSync(SIDECARS, 0o500);
    renameSync(filePath, movedPath);
    await assert.rejects(provider.hasMovedFile(filePath, movedPath));
    chmodSync(SIDECARS, 0o700);

    const listing = await workspaceListing([movedPath]);
    assert.deepEqual(
      listing.ownerless.map((entry) => [entry.file, entry.documentPath]),
      [[sidecarFile, filePath]],
      "the state is still at the key of the old path, where no file is",
    );
    assert.deepEqual(listing.sessions, [], "the moved document has no state");
  });

  it("does not name the sidecar of a document that has its file", async function () {
    await annotateAndClose(filePath);

    // The window leaves the document out of its paths: a file filter hides it.
    assert.deepEqual(await sidecarsOfNoDocument([]), []);
  });

  it("does not name the sidecar of a document outside the open workspaces", async function () {
    // A file on a volume that is not mounted has no file at its path, and it
    // is not a deleted document.
    const outsidePath = path.join(outside, "note.md");
    writeFileSync(outsidePath, SOURCE, "utf-8");
    await annotateAndClose(outsidePath);
    await rm(outside, { recursive: true, force: true });

    assert.deepEqual(await sidecarsOfNoDocument([filePath]), []);
  });
});

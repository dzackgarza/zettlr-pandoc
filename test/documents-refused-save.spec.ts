/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider refused-save specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager into a save and a reload
 *                  that it must refuse. Each refusal has a reason and names
 *                  its cause: the file of a reviewed document cannot be read,
 *                  the file cannot be written, the document is not loaded,
 *                  or the review of a document that the author loads from
 *                  disk cannot be written. A document whose save was refused
 *                  keeps its unsaved text and stays modified, so a close or
 *                  a quit still asks the author about that text. A
 *                  refused save that the author asked for at a quit goes to
 *                  the window, and a refused reload says that a reload was
 *                  refused. The author can write the text of a document
 *                  that cannot be saved to another file (#178).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { BrowserWindow } from "electron";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { sha256Text } from "source/common/util/sha256";
import { SAVE_REFUSED_CHANNEL, type SaveRefusedBroadcast } from "source/types/common/documents";
import { bootDocumentManager } from "./documents-provider-seam";
import {
  appListeners,
  appQuitRequests,
  ipcMainHandlers,
  messageBoxes,
  saveDialogs,
  sentMessagesFor,
  userData,
} from "./headless-electron-harness.cjs";

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

const SOURCE = "An even unimodular lattice has a rank that 8 divides.\n";
const REVISED = SOURCE.replace("rank", "signature");
// The file as another program wrote it while the document was open.
const EXTERNAL = `${SOURCE}The Leech lattice has rank 24.\n`;
const SIDECARS = path.join(userData, "review-sidecars");
// The first button of the quit prompt: save the unsaved text.
const SAVE = 0;

describe("Documents-provider save that it must refuse", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;
  let windowId: string;
  let window: BrowserWindow;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-refused-save-"));
    filePath = path.join(root, "note.md");
    writeFileSync(filePath, SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    mkdirSync(SIDECARS);
    appListeners.delete("before-quit");
    appQuitRequests.length = 0;
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;
    saveDialogs.shown.length = 0;
    saveDialogs.answer = undefined;

    provider = await bootDocumentManager(root);
    windowId = provider.windowKeys()[0];
    window = new BrowserWindow();
  });

  afterEach(async function () {
    chmodSync(SIDECARS, 0o700);
    chmodSync(filePath, 0o600);
    window.close();
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  function pane(): string {
    const leaves = provider.leafIds(windowId);
    assert.equal(leaves.length, 1, "the window has one pane");
    return leaves[0];
  }

  /** Opens the file in the pane and opens a review on it. The proposal is unsaved text. */
  async function openWithReview(): Promise<string> {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
    const id = provider.getDocumentId(filePath);
    assert.ok(id !== undefined, "a loaded document has an id");
    const submitted = await provider.submitProposal(
      id,
      sha256Text(SOURCE),
      [
        {
          description: "Name the signature",
          patch: createPatch("document", SOURCE, REVISED, "", "", { context: 0 }),
        },
      ],
      "refused-save-proposal",
      0,
    );
    assert.ok(submitted.ok, "the proposal opens a review");
    assert.equal(provider.isModified(filePath), true, "the proposal is unsaved text");
    return id;
  }

  /**
   * Opens the file with a review whose proposal the author accepted. The
   * accepted text is unsaved text of the author, so a quit asks about it.
   */
  async function openWithAcceptedText(): Promise<void> {
    const id = await openWithReview();
    const status = provider.reviewStatus(id);
    assert.ok(status !== undefined, "the document has a review");
    const accepted = await provider.acceptAllReviewChunks(status.reviewId, {
      expectedReviewGeneration: status.generation,
      expectedWorkingSha256: sha256Text(REVISED),
    });
    assert.ok(accepted.ok, "the author accepts the proposal");
    assert.equal(provider.readMarkdownBufferContent(filePath), REVISED);
  }

  function refusals(): SaveRefusedBroadcast[] {
    return sentMessagesFor(window)
      .filter(([channel]) => channel === SAVE_REFUSED_CHANNEL)
      .map(([, payload]) => payload as SaveRefusedBroadcast);
  }

  async function untilRefused(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (refusals().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function invoke(command: string, payload: unknown): Promise<unknown> {
    const handler = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(handler !== undefined, "the documents-provider handler is registered");
    return await handler(undefined, { command, payload });
  }

  it("answers with the read failure when the file of a reviewed document cannot be read", async function () {
    await openWithReview();
    chmodSync(filePath, 0o000);

    const saved = await provider.saveFile(filePath);

    assert.deepEqual(
      [saved.ok, saved.ok ? undefined : saved.refusal.reason],
      [false, "disk-unreadable"],
      "the save is refused, with the reason that the file cannot be read",
    );
    chmodSync(filePath, 0o600);
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "nothing was written");
    assert.equal(provider.isModified(filePath), true, "the document keeps its unsaved text");
  });

  it("tells the window when a save at a quit is refused for a file that cannot be read", async function () {
    await openWithAcceptedText();
    chmodSync(filePath, 0o000);
    messageBoxes.answer = SAVE;

    const listeners = appListeners.get("before-quit");
    if (listeners?.length !== 1) {
      assert.fail("the provider registers the one before-quit listener");
    }
    listeners[0]({ preventDefault: () => {} });
    await untilRefused();

    assert.deepEqual(
      refusals().map((entry) => [entry.filePath, entry.refusal.reason]),
      [[filePath, "disk-unreadable"]],
      "the window receives the refusal of the save, with its reason",
    );
    assert.equal(appQuitRequests.length, 0, "the quit did not go on");
  });

  it("keeps the document modified when its file cannot be written", async function () {
    await openWithAcceptedText();
    // The file can be read and not written.
    chmodSync(filePath, 0o400);

    const saved = await provider.saveFile(filePath);

    assert.deepEqual(
      [saved.ok, saved.ok ? undefined : saved.refusal.reason],
      [false, "write-failed"],
      "the save is refused, with the reason that the write failed",
    );
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "nothing was written");
    assert.equal(
      provider.isModified(filePath),
      true,
      "the document has text that is not on disk, so it is modified",
    );
    assert.equal(provider.settlesBeforeQuit(), true, "a quit asks the author about that text");
  });

  it("says that the file was written when its new state cannot be read", async function () {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: "Let p be a prime.\n" },
    ]);
    // The file can be written and not read.
    chmodSync(filePath, 0o200);

    const saved = await provider.saveFile(filePath);

    chmodSync(filePath, 0o600);
    assert.deepEqual(
      [saved.ok, saved.ok ? undefined : saved.refusal.reason],
      [false, "saved-not-refreshed"],
      "the save answers that the file was written and not read again",
    );
    assert.equal(
      readFileSync(filePath, "utf-8"),
      `Let p be a prime.\n${SOURCE}`,
      "the file holds the text of the document",
    );
    assert.equal(
      provider.isModified(filePath),
      false,
      "the text is on disk, so a close asks nothing",
    );
  });

  it("writes the text of a document that cannot be saved to the file that the author chooses", async function () {
    await openWithReview();
    chmodSync(filePath, 0o400);
    const copyPath = path.join(root, "rescued.md");
    saveDialogs.answer = copyPath;

    assert.equal(await invoke("save-copy", { path: filePath }), copyPath);

    assert.deepEqual(
      saveDialogs.shown.map((options) => options.defaultPath),
      [path.join(root, "note copy.md")],
      "the dialog starts beside the document, at a name that is not the name of the document",
    );
    assert.equal(readFileSync(copyPath, "utf-8"), REVISED, "the copy has the text of the editor");
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the file of the document is unchanged");
    assert.equal(provider.isModified(filePath), true, "the document keeps its unsaved text");
  });

  it("writes nothing when the author cancels the copy", async function () {
    await openWithReview();
    saveDialogs.answer = null;

    assert.equal(await invoke("save-copy", { path: filePath }), undefined);

    assert.equal(saveDialogs.shown.length, 1, "the author was asked for a file");
    assert.deepEqual(readdirSync(root), ["note.md"], "no file was made");
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the file of the document is unchanged");
  });

  it("answers with a reason for a document that is not loaded", async function () {
    const saved = await provider.saveFile(filePath);

    assert.deepEqual(
      [saved.ok, saved.ok ? undefined : saved.refusal.reason],
      [false, "not-loaded"],
      "a refused save has a reason",
    );
  });

  it("says that a reload was refused when the review of a reloaded document cannot be written", async function () {
    const id = await openWithReview();
    writeFileSync(filePath, EXTERNAL, "utf-8");
    chmodSync(SIDECARS, 0o500);

    await invoke("load-from-disk", { path: filePath });

    assert.deepEqual(
      refusals().map((entry) => entry.refused),
      [{ documentId: id, action: "reload" }],
      "the refusal names the document and the action that was refused",
    );
    assert.equal(provider.readWorkingText(id), REVISED, "a refused reload keeps the buffer");

    // The action of the refusal loads the disk version without the review
    // state that could not be written.
    assert.equal(await invoke("close-without-review", { documentId: id }), true);
    assert.deepEqual(provider.loadedDocuments, [], "the document waits for its editors to load it");
    await provider.getDocument(filePath);
    assert.equal(provider.readWorkingText(id), EXTERNAL, "the editors load the text of the file");
  });
});

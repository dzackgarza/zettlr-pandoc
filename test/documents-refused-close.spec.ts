/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider refused-close specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager into a close that it must
 *                  refuse: the sidecar directory loses its write permission,
 *                  so the collaboration state of a document cannot be written.
 *                  Each refusal names the document, and the command
 *                  `close-without-review` then closes the document or ends
 *                  the quit without that state. The sidecar stays as it was
 *                  last written. The answer "discard" at a close prompt is
 *                  refused the same way when the discard cannot be done: the
 *                  state cannot be written, or the file cannot be read (#178).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { BrowserWindow } from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { sha256Text } from "source/common/util/sha256";
import { SAVE_REFUSED_CHANNEL, type SaveRefusedBroadcast } from "source/types/common/documents";
import {
  bootDocumentManager,
  emitWatchdogEvent,
  fileDeleteCommand,
  openMainWindow,
} from "./documents-provider-seam";
import {
  appListeners,
  appQuitRequests,
  ipcMainHandlers,
  messageBoxes,
  sentMessagesFor,
  userData,
} from "./headless-electron-harness.cjs";

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

const SOURCE = "An even unimodular lattice has a rank that 8 divides.\n";
const ANNOTATED = "even unimodular";
const REVISED = SOURCE.replace("rank", "signature");
const SIDECARS = path.join(userData, "review-sidecars");
const DRAFT = "Draft: ";
// The second button of each close prompt: discard the unsaved text.
const DISCARD = 1;
// The first button of the delete prompt: delete the file.
const DELETE = 0;

describe("Documents-provider close that cannot write the collaboration state", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;
  let windowId: string;
  let window: BrowserWindow;
  /** The main windows that a case opened for window ids of the provider. */
  let mainWindows: BrowserWindow[];

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-refused-close-"));
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

    provider = await bootDocumentManager(root);
    windowId = provider.windowKeys()[0];
    window = new BrowserWindow();
    mainWindows = [];
  });

  afterEach(async function () {
    chmodSync(SIDECARS, 0o700);
    window.close();
    for (const mainWindow of mainWindows) {
      mainWindow.close();
    }
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  /** The one pane of a window. The provider makes a new one when the last tab closes. */
  function pane(ofWindow: string = windowId): string {
    const leaves = provider.leafIds(ofWindow);
    assert.equal(leaves.length, 1, "the window has one pane");
    return leaves[0];
  }

  /** Opens the file in the pane of a window and gives it one annotation. */
  async function openAndAnnotate(
    inWindow: string = windowId,
  ): Promise<{ id: string; annotation: string }> {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(inWindow, pane(inWindow), filePath), true);
    const id = provider.getDocumentId(filePath);
    assert.ok(id !== undefined, "a loaded document has an id");
    const from = SOURCE.indexOf(ANNOTATED);
    const created = await provider.createAnnotation(
      id,
      "owner",
      from,
      from + ANNOTATED.length,
      "State the indefinite case.",
      provider.annotationQueries.getAnnotations(id).generation,
    );
    if ("ok" in created) {
      assert.fail(`The annotation was refused: ${created.code}`);
    }
    return { id, annotation: created.annotationId };
  }

  /** The documents that a refused close named to the window, in order. */
  function refusedCloses(): Array<string | undefined> {
    return sentMessagesFor(window)
      .filter(([channel]) => channel === SAVE_REFUSED_CHANNEL)
      .map(([, payload]) => (payload as SaveRefusedBroadcast).refused?.documentId);
  }

  /** A second window of the provider, and a main window for each of the two. */
  function twoMainWindows(): { second: string; ofFirst: BrowserWindow; ofSecond: BrowserWindow } {
    provider.newWindow();
    const second = provider.windowKeys().find((key) => key !== windowId);
    assert.ok(second !== undefined, "the provider has a second window");
    const ofFirst = openMainWindow(windowId);
    const ofSecond = openMainWindow(second);
    mainWindows.push(ofFirst, ofSecond);
    return { second, ofFirst, ofSecond };
  }

  /** The number of refusals that a window got. */
  function refusalsIn(mainWindow: BrowserWindow): number {
    return sentMessagesFor(mainWindow).filter(([channel]) => channel === SAVE_REFUSED_CHANNEL)
      .length;
  }

  /** The action that each refused close named to the window as stopped, in order. */
  function refusedActions(): Array<string | undefined> {
    return sentMessagesFor(window)
      .filter(([channel]) => channel === SAVE_REFUSED_CHANNEL)
      .map(([, payload]) => (payload as SaveRefusedBroadcast).refused?.action);
  }

  /** The annotations in the sidecar of each document, by the path of the document. */
  async function annotationsInSidecars(): Promise<Array<[string, string[]]>> {
    const sidecars = await provider.annotationQueries.listCollaborationSidecars();
    return sidecars.map((sidecar) => [
      sidecar.documentPath,
      sidecar.annotations.items.map((item) => item.annotationId),
    ]);
  }

  /** The command that the action of the refusal sends. */
  async function closeWithoutReview(documentId: string): Promise<unknown> {
    const handler = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(handler !== undefined, "the documents-provider handler is registered");
    return await handler(undefined, { command: "close-without-review", payload: { documentId } });
  }

  function annotationsInMemory(documentId: string): string[] {
    return provider.annotationQueries
      .getAnnotations(documentId)
      .items.map((item) => item.annotationId);
  }

  /** The author types at the start of the document and does not save. */
  async function typeDraft(): Promise<void> {
    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: DRAFT },
    ]);
    assert.equal(provider.isModified(filePath), true, "the document has unsaved text");
  }

  /** Fires the before-quit listener. Answers whether the provider stopped the quit. */
  function requestQuit(): boolean {
    const listeners = appListeners.get("before-quit");
    if (listeners?.length !== 1) {
      assert.fail("the provider registers the one before-quit listener");
    }
    let stopped = false;
    listeners[0]({
      preventDefault: () => {
        stopped = true;
      },
    });
    return stopped;
  }

  async function untilRefused(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (refusedCloses().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("closes a document in a pane without the state that it could not write", async function () {
    const { id, annotation } = await openAndAnnotate();

    chmodSync(SIDECARS, 0o500);
    assert.equal(
      await provider.closeFile(windowId, pane(), filePath),
      false,
      "the close is refused",
    );
    assert.deepEqual(refusedCloses(), [id], "the refusal names the document to the window");
    assert.deepEqual(annotationsInMemory(id), [annotation], "a refused close keeps the state");

    assert.equal(await closeWithoutReview(id), true);
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
    assert.deepEqual(annotationsInMemory(id), [], "its state is not in memory");
    assert.deepEqual(refusedCloses(), [id], "the repeated close is not refused again");

    chmodSync(SIDECARS, 0o700);
    await provider.getDocument(filePath);
    assert.deepEqual(
      annotationsInMemory(id),
      [annotation],
      "the next load attaches the sidecar as it was last written",
    );
  });

  it("ends a quit without the review of a document that no pane shows", async function () {
    const id = provider.ensureDocumentId(filePath);
    const submitted = await provider.submitProposal(
      id,
      sha256Text(SOURCE),
      [
        {
          description: "Name the signature",
          patch: createPatch("document", SOURCE, REVISED, "", "", { context: 0 }),
        },
      ],
      "refused-quit-proposal",
      0,
    );
    assert.ok(submitted.ok, "the proposal opens a review");

    chmodSync(SIDECARS, 0o500);
    assert.equal(requestQuit(), true);
    await untilRefused();
    assert.deepEqual(refusedCloses(), [id], "the refused quit names the document to the window");
    assert.deepEqual(refusedActions(), ["quit"], "and the quit as the action that it stopped");
    assert.equal(appQuitRequests.length, 0, "the quit did not go on");
    assert.equal(provider.readWorkingText(id), REVISED, "a refused quit keeps the document");

    assert.equal(await closeWithoutReview(id), true);
    assert.equal(appQuitRequests.length, 1, "the quit goes on");
    assert.deepEqual(provider.loadedDocuments, []);
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the proposal is not on disk");

    chmodSync(SIDECARS, 0o700);
    const sidecars = await provider.annotationQueries.listCollaborationSidecars();
    assert.deepEqual(
      sidecars.map((sidecar) => [sidecar.documentPath, sidecar.review?.reviewId]),
      [[filePath, submitted.reviewId]],
      "the sidecar holds the review as the proposal wrote it",
    );
  });

  it("does nothing for a document whose close went through after the refusal", async function () {
    const { id, annotation } = await openAndAnnotate();
    chmodSync(SIDECARS, 0o500);
    assert.equal(await provider.closeFile(windowId, pane(), filePath), false);
    chmodSync(SIDECARS, 0o700);
    assert.equal(await provider.closeFile(windowId, pane(), filePath), true, "the retry closes");
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);

    // The window still shows the refusal of the first close, with its action.
    assert.equal(await closeWithoutReview(id), false);
    assert.deepEqual(
      provider.loadedDocuments.map((document) => document.filePath),
      [filePath],
      "the open document stays open",
    );
    assert.deepEqual(annotationsInMemory(id), [annotation], "and it keeps its state");
  });

  it("keeps a window whose document it could not close", async function () {
    provider.newWindow();
    const second = provider.windowKeys().find((key) => key !== windowId);
    assert.ok(second !== undefined, "the provider has a second window");
    const { id, annotation } = await openAndAnnotate(second);
    const repeated: string[] = [];
    const closeAgain = async (): Promise<void> => {
      repeated.push(second);
    };

    chmodSync(SIDECARS, 0o500);
    assert.equal(await provider.closeWindow(second, closeAgain), false, "the window must stay");
    assert.deepEqual(provider.windowKeys(), [windowId, second], "the provider keeps the window");
    assert.deepEqual(refusedCloses(), [id], "the refusal names the document to the window");
    assert.deepEqual(annotationsInMemory(id), [annotation], "a refused close keeps the state");
    assert.deepEqual(repeated, [], "nothing repeats the close before the author answers");

    assert.equal(await closeWithoutReview(id), true);
    assert.deepEqual(repeated, [second], "the action of the refusal repeats the close");
    assert.equal(await provider.closeWindow(second, closeAgain), true, "the window may close");
    assert.deepEqual(provider.windowKeys(), [windowId], "the provider has the first window only");
    assert.deepEqual(provider.loadedDocuments, [], "the document of the window is closed");
  });

  it("tells the window that the author closes, and no other window", async function () {
    const { second, ofFirst, ofSecond } = twoMainWindows();
    await openAndAnnotate(second);

    chmodSync(SIDECARS, 0o500);
    assert.equal(await provider.closeWindow(second, async () => {}), false, "the window stays");
    assert.equal(refusalsIn(ofSecond), 1, "the window of the close names the cause");
    assert.equal(refusalsIn(ofFirst), 0, "the other window shows no message");
  });

  it("tells each window that shows the document about a close that no window started", async function () {
    const { second, ofFirst, ofSecond } = twoMainWindows();
    await openAndAnnotate(second);

    chmodSync(SIDECARS, 0o500);
    assert.equal(await provider.closeFileEverywhere(filePath), false, "the document stays");
    assert.equal(refusalsIn(ofSecond), 1, "the window that shows the document names the cause");
    assert.equal(refusalsIn(ofFirst), 0, "a window without the document shows no message");

    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
    assert.equal(await provider.closeFileEverywhere(filePath), false, "the document stays");
    assert.equal(refusalsIn(ofSecond), 2, "each window that shows the document gets the cause");
    assert.equal(refusalsIn(ofFirst), 1, "each window that shows the document gets the cause");
  });

  it("closes a window whose unsaved text the author discards", async function () {
    provider.newWindow();
    const second = provider.windowKeys().find((key) => key !== windowId);
    assert.ok(second !== undefined, "the provider has a second window");
    const { annotation } = await openAndAnnotate(second);
    await typeDraft();
    const closeAgain = async (): Promise<void> => {};

    messageBoxes.answer = DISCARD;
    const mayClose = await provider.askUserToCloseWindow(second, closeAgain);

    assert.equal(messageBoxes.shown.length, 1, "the close asks about the unsaved text");
    assert.equal(mayClose, true, "the window may close");
    assert.deepEqual(provider.windowKeys(), [windowId], "the provider has the first window only");
    assert.deepEqual(provider.loadedDocuments, [], "the document of the window is closed");
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the discarded text is not on disk");
    assert.deepEqual(
      await annotationsInSidecars(),
      [[filePath, [annotation]]],
      "the annotation of the document is in its sidecar",
    );
  });

  it("keeps the tab of a document that it could not close in every pane", async function () {
    const { id, annotation } = await openAndAnnotate();

    chmodSync(SIDECARS, 0o500);
    const closed = await provider.closeFileEverywhere(filePath);
    assert.equal(provider.getActiveFile(pane()), filePath, "the pane still shows the document");
    assert.equal(closed, false, "the close is refused");
    assert.deepEqual(refusedCloses(), [id], "the refusal names the document to the window");
    assert.deepEqual(annotationsInMemory(id), [annotation], "a refused close keeps the state");

    assert.equal(await closeWithoutReview(id), true);
    assert.equal(provider.getActiveFile(pane()), undefined, "the pane shows no document");
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
  });

  it("keeps a document whose file another program removed, and names the cause", async function () {
    const { id, annotation } = await openAndAnnotate();

    chmodSync(SIDECARS, 0o500);
    unlinkSync(filePath);
    emitWatchdogEvent("unlink", filePath);
    await untilRefused();

    assert.deepEqual(refusedCloses(), [id], "the window gets the cause of the close that failed");
    assert.equal(provider.getActiveFile(pane()), filePath, "the pane still shows the document");
    assert.deepEqual(annotationsInMemory(id), [annotation], "the annotation is still in memory");

    assert.equal(await closeWithoutReview(id), true);
    assert.deepEqual(provider.loadedDocuments, [], "the action closes the document");
  });

  it("does not delete a file whose document it could not close", async function () {
    const { id, annotation } = await openAndAnnotate();
    const command = fileDeleteCommand(provider);

    chmodSync(SIDECARS, 0o500);
    messageBoxes.answer = DELETE;
    const outcome = await command.run("file-delete", { path: filePath }).then(
      () => "deleted",
      () => "refused",
    );
    assert.equal(existsSync(filePath), true, "the file is on disk");
    assert.equal(outcome, "refused", "the command reports that it did not delete the file");
    assert.deepEqual(refusedCloses(), [id], "the refusal names the document to the window");
    assert.equal(provider.getActiveFile(pane()), filePath, "the pane still shows the document");
    assert.deepEqual(annotationsInMemory(id), [annotation], "a refused close keeps the state");

    chmodSync(SIDECARS, 0o700);
    assert.equal(await command.run("file-delete", { path: filePath }), true, "the retry deletes");
    assert.equal(existsSync(filePath), false, "the file is gone");
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
  });

  it("closes a tab whose unsaved text the author discards, when the state cannot be written", async function () {
    const { id, annotation } = await openAndAnnotate();
    await typeDraft();

    chmodSync(SIDECARS, 0o500);
    messageBoxes.answer = DISCARD;
    assert.equal(
      await provider.closeFile(windowId, pane(), filePath),
      false,
      "the close is refused",
    );
    assert.deepEqual(refusedCloses(), [id], "the refusal names the document to the window");
    assert.equal(
      provider.readWorkingText(id),
      `${DRAFT}${SOURCE}`,
      "a refused discard keeps the text",
    );
    assert.deepEqual(annotationsInMemory(id), [annotation], "and the state");

    assert.equal(await closeWithoutReview(id), true);
    assert.equal(messageBoxes.shown.length, 1, "the repeated close does not ask again");
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
    assert.equal(provider.getActiveFile(pane()), undefined, "the pane shows no document");
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the discarded text is not on disk");

    chmodSync(SIDECARS, 0o700);
    await provider.getDocument(filePath);
    assert.equal(provider.readWorkingText(id), SOURCE, "the next load has the text of the file");
    assert.deepEqual(annotationsInMemory(id), [annotation], "and the sidecar as last written");
  });

  it("keeps the sidecar of a document whose later text the author discards after the action of a refusal", async function () {
    const { id, annotation } = await openAndAnnotate();
    chmodSync(SIDECARS, 0o500);
    assert.equal(
      await provider.closeFile(windowId, pane(), filePath),
      false,
      "the close is refused",
    );
    chmodSync(SIDECARS, 0o700);
    // The author goes on with the document, and takes the action of the
    // refusal afterwards: the close then asks about the unsaved text.
    await typeDraft();
    assert.deepEqual(await annotationsInSidecars(), [[filePath, [annotation]]]);

    messageBoxes.answer = DISCARD;
    assert.equal(await closeWithoutReview(id), true);
    assert.equal(messageBoxes.shown.length, 1, "the repeated close asks about the unsaved text");
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the discarded text is not on disk");
    assert.deepEqual(
      await annotationsInSidecars(),
      [[filePath, [annotation]]],
      "the sidecar stays as it was last written",
    );
  });

  it("ends a quit whose unsaved text the author discards, when the state cannot be written", async function () {
    const { id } = await openAndAnnotate();
    await typeDraft();

    chmodSync(SIDECARS, 0o500);
    messageBoxes.answer = DISCARD;
    assert.equal(requestQuit(), true);
    await untilRefused();
    assert.deepEqual(refusedCloses(), [id], "the refused quit names the document to the window");
    assert.deepEqual(refusedActions(), ["quit"], "and the quit as the action that it stopped");
    assert.equal(appQuitRequests.length, 0, "the quit did not go on");

    assert.equal(await closeWithoutReview(id), true);
    assert.equal(appQuitRequests.length, 1, "the quit goes on");
    assert.equal(requestQuit(), false, "the repeated quit has nothing to settle");
    assert.equal(messageBoxes.shown.length, 1, "and it does not ask again");
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the discarded text is not on disk");
  });

  it("ends a quit whose unsaved text the author discards, when the file cannot be read", async function () {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
    const id = provider.getDocumentId(filePath);
    assert.ok(id !== undefined, "a loaded document has an id");
    await typeDraft();

    chmodSync(filePath, 0o000);
    messageBoxes.answer = DISCARD;
    assert.equal(requestQuit(), true);
    await untilRefused();
    assert.deepEqual(refusedCloses(), [id], "the refused quit names the document to the window");
    assert.deepEqual(refusedActions(), ["quit"], "and the quit as the action that it stopped");
    assert.equal(appQuitRequests.length, 0, "the quit did not go on");

    assert.equal(await closeWithoutReview(id), true);
    assert.equal(appQuitRequests.length, 1, "the quit goes on");
    assert.deepEqual(provider.loadedDocuments, [], "the document is closed");
    chmodSync(filePath, 0o600);
    assert.equal(readFileSync(filePath, "utf-8"), SOURCE, "the discarded text is not on disk");
  });
});

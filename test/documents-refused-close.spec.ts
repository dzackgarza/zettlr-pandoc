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
 *                  last written (#178).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { BrowserWindow } from "electron";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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

describe("Documents-provider close that cannot write the collaboration state", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;
  let windowId: string;
  let window: BrowserWindow;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-refused-close-"));
    filePath = path.join(root, "note.md");
    writeFileSync(filePath, SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    appListeners.delete("before-quit");
    appQuitRequests.length = 0;

    provider = await bootDocumentManager(root);
    windowId = provider.windowKeys()[0];
    window = new BrowserWindow();
  });

  afterEach(async function () {
    chmodSync(SIDECARS, 0o700);
    window.close();
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  /** The one pane of the window. The provider makes a new one when the last tab closes. */
  function pane(): string {
    const leaves = provider.leafIds(windowId);
    assert.equal(leaves.length, 1, "the window has one pane");
    return leaves[0];
  }

  /** Opens the file in the pane and gives it one annotation. */
  async function openAndAnnotate(): Promise<{ id: string; annotation: string }> {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
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
      .map(([, payload]) => (payload as SaveRefusedBroadcast).closeRefusedFor);
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
    const listeners = appListeners.get("before-quit") ?? [];
    assert.equal(listeners.length, 1, "the provider registers the one before-quit listener");
    listeners[0]({ preventDefault: () => {} });
    const deadline = Date.now() + 5000;
    while (refusedCloses().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(refusedCloses(), [id], "the refused quit names the document to the window");
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
});

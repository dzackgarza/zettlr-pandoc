/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider quit with an open review
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager's before-quit listener
 *                  and a second manager over the same profile, which is the
 *                  next start of the app. A proposal that the author did not
 *                  decide on reaches the file of its document by no answer
 *                  of the quit prompt, and the review with its working text
 *                  is there at the next start. Text that the author accepted
 *                  from a review is unsaved text of the author: a quit asks
 *                  about it, and the next load of a closed document has it
 *                  (#146), also when another program changed the file
 *                  (#210).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import type { DocumentsUpdateContext } from "source/app/service-providers/documents";
import type { ReviewStatus } from "source/app/service-providers/documents/review-diff-store";
import { sha256Text } from "source/common/util/sha256";
import {
  DP_EVENTS,
  REMOTE_CHANGE_KEPT_CHANNEL,
  type RemoteChangeKeptBroadcast,
} from "source/types/common/documents";
import { bootDocumentManager } from "./documents-provider-seam";
import {
  appListeners,
  appQuitRequests,
  messageBoxes,
  sentMessagesFor,
  userData,
} from "./headless-electron-harness.cjs";
import { invokeMain } from "./main-ipc";

const REVIEWED_SOURCE = "A lattice is a free abelian group with a bilinear form.\n";
const REVIEWED_TARGET = REVIEWED_SOURCE.replace("bilinear", "symmetric bilinear");
const AUTHOR_PREFIX = "Definition. ";
const DRAFT_SOURCE = "The author is typing here.\n";
const CHANGED_ON_DISK = `${REVIEWED_SOURCE}Another program wrote this line.\n`;
const DRAFT_EDIT = "Draft: ";
const SIDECARS = path.join(userData, "review-sidecars");
// The quit dialog's buttons: Save, Discard, Cancel.
const SAVE = 0;
const DISCARD = 1;

interface QuitEvent {
  prevented: boolean;
  preventDefault: () => void;
}

interface OpenReview {
  reviewId: string;
  generation: number;
}

describe("Documents-provider quit with an open review", function () {
  let root: string;
  let reviewedPath: string;
  let draftPath: string;
  let provider: DocumentManager;
  let windowId: string;
  let leafId: string;

  /**
   * Fire the before-quit listener and wait for its outcome: a quit request
   * or an event that the listener did not prevent. The writes before and
   * after the dialog are real file I/O, so this waits on the outcome.
   */
  async function requestQuit(): Promise<QuitEvent> {
    const listeners = appListeners.get("before-quit");
    if (listeners?.length !== 1) {
      assert.fail("the provider registers the one before-quit listener");
    }
    const quitsBefore = appQuitRequests.length;
    const event: QuitEvent = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    listeners[0](event);
    const deadline = Date.now() + 3000;
    while (event.prevented && appQuitRequests.length === quitsBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return event;
  }

  /** The next start of the app: a new manager over the same profile. */
  async function restart(): Promise<void> {
    await provider.shutdown();
    appListeners.delete("before-quit");
    provider = await bootDocumentManager([root]);
    windowId = provider.windowKeys()[0];
  }

  /**
   * Loads the reviewed document as an editor does and gives the status of
   * its review. A document has a new id in each session.
   */
  async function loadedReviewStatus(): Promise<ReviewStatus | undefined> {
    await provider.getDocument(reviewedPath);
    const documentId = provider.getDocumentId(reviewedPath);
    assert.ok(documentId !== undefined, "a loaded document has an id");
    return provider.reviewStatus(documentId);
  }

  async function show(filePath: string): Promise<void> {
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, leafId, filePath), true);
  }

  /** An agent proposes a change to the reviewed document. */
  async function propose(): Promise<OpenReview> {
    const documentId = provider.ensureDocumentId(reviewedPath);
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(REVIEWED_SOURCE),
      [
        {
          description: "Name the symmetry",
          patch: createPatch("document", REVIEWED_SOURCE, REVIEWED_TARGET, "", "", { context: 0 }),
        },
      ],
      "quit-with-review-proposal",
      0,
    );
    if (!submitted.ok) {
      assert.fail(`The review proposal was refused: ${submitted.code}`);
    }
    assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 1);
    return { reviewId: submitted.reviewId, generation: submitted.reviewGeneration };
  }

  /**
   * The author accepts the proposal of the closed reviewed document in the
   * Annotations view. No file is written.
   */
  async function acceptInAnnotationsView(review: OpenReview): Promise<void> {
    const accepted = await invokeMain("documents:accept-all-workspace-review-chunks", {
      path: reviewedPath,
      reviewId: review.reviewId,
      expectedReviewGeneration: review.generation,
      expectedWorkingSha256: sha256Text(REVIEWED_TARGET),
    });
    assert.deepEqual(
      [accepted.ok, readFileSync(reviewedPath, "utf-8")],
      [true, REVIEWED_SOURCE],
      "the author accepts the proposal of the closed document, and no file is written",
    );
  }

  async function editDraft(): Promise<void> {
    await show(draftPath);
    await provider.applyWorkspaceTextEdits([
      { documentPath: draftPath, range: { from: 0, to: 0 }, insert: DRAFT_EDIT },
    ]);
    assert.equal(provider.isModified(draftPath), true);
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-quit-review-"));
    reviewedPath = path.join(root, "Reviewed.md");
    draftPath = path.join(root, "Draft.md");
    writeFileSync(reviewedPath, REVIEWED_SOURCE, "utf-8");
    writeFileSync(draftPath, DRAFT_SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    appListeners.delete("before-quit");
    appQuitRequests.length = 0;
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;

    provider = await bootDocumentManager([root]);
    windowId = provider.windowKeys()[0];
    leafId = provider.leafIds(windowId)[0];
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  describe("a document in a pane with a proposal that the author did not decide on", function () {
    it("keeps the proposal out of the file when the author saves the other changes", async function () {
      await show(reviewedPath);
      await propose();
      await editDraft();

      messageBoxes.answer = SAVE;
      await requestQuit();

      assert.equal(appQuitRequests.length, 1, "the quit goes on");
      assert.equal(
        readFileSync(reviewedPath, "utf-8"),
        REVIEWED_SOURCE,
        "the file of the reviewed document has no text of the proposal",
      );
      assert.equal(
        readFileSync(draftPath, "utf-8"),
        `${DRAFT_EDIT}${DRAFT_SOURCE}`,
        "the edit of the author is saved",
      );
      assert.equal(messageBoxes.shown.length, 1, "the author is asked one time");
      const detail = messageBoxes.shown[0].detail;
      if (detail === undefined) {
        assert.fail("the prompt names its documents");
      }
      const [asked, kept] = detail.split("\n\n");
      assert.equal(asked, draftPath, "the prompt asks about the document of the author");
      assert.equal(
        kept?.split("\n").at(-1),
        reviewedPath,
        "the prompt names the document that keeps its open review",
      );

      await restart();
      assert.equal(
        (await loadedReviewStatus())?.unresolvedChunks,
        1,
        "the review is there at the next start",
      );
      assert.equal(
        provider.readMarkdownBufferContent(reviewedPath),
        REVIEWED_TARGET,
        "the proposal is in the text of the editor at the next start",
      );
    });

    it("quits with no prompt when the proposal is the only unsaved text", async function () {
      await show(reviewedPath);
      await propose();

      await requestQuit();

      assert.deepEqual(messageBoxes.shown, [], "there is nothing to ask the author");
      assert.equal(readFileSync(reviewedPath, "utf-8"), REVIEWED_SOURCE);

      await restart();
      assert.equal((await loadedReviewStatus())?.unresolvedChunks, 1);
      assert.equal(provider.readMarkdownBufferContent(reviewedPath), REVIEWED_TARGET);
    });

    it("keeps an edit of the author in the reviewed document for the next start", async function () {
      await show(reviewedPath);
      await propose();
      await provider.applyWorkspaceTextEdits([
        { documentPath: reviewedPath, range: { from: 0, to: 0 }, insert: AUTHOR_PREFIX },
      ]);

      await requestQuit();

      assert.deepEqual(messageBoxes.shown, [], "there is nothing to ask the author");
      assert.equal(readFileSync(reviewedPath, "utf-8"), REVIEWED_SOURCE);

      await restart();
      assert.equal((await loadedReviewStatus())?.unresolvedChunks, 1);
      assert.equal(
        provider.readMarkdownBufferContent(reviewedPath),
        `${AUTHOR_PREFIX}${REVIEWED_TARGET}`,
        "the edit and the proposal are in the text of the editor at the next start",
      );
    });

    it("keeps the review when the author discards the other changes", async function () {
      await show(reviewedPath);
      await propose();
      await editDraft();

      messageBoxes.answer = DISCARD;
      await requestQuit();

      assert.equal(appQuitRequests.length, 1, "the quit goes on");
      assert.equal(readFileSync(draftPath, "utf-8"), DRAFT_SOURCE, "the edit is discarded");
      assert.equal(readFileSync(reviewedPath, "utf-8"), REVIEWED_SOURCE);

      await restart();
      assert.equal(
        (await loadedReviewStatus())?.unresolvedChunks,
        1,
        "the discard of other changes leaves the review",
      );
      assert.equal(provider.readMarkdownBufferContent(reviewedPath), REVIEWED_TARGET);
    });
  });

  describe("a saved review at the close of its tab (#57)", function () {
    it("stays when the author discards a later edit", async function () {
      await show(reviewedPath);
      const { reviewId } = await propose();
      const saved = await provider.saveFile(reviewedPath);
      assert.equal(saved.ok, true, "the author saves the document while the review is open");
      assert.equal(readFileSync(reviewedPath, "utf-8"), REVIEWED_TARGET);
      await provider.applyWorkspaceTextEdits([
        { documentPath: reviewedPath, range: { from: 0, to: 0 }, insert: AUTHOR_PREFIX },
      ]);
      assert.equal(provider.isModified(reviewedPath), true);

      messageBoxes.answer = DISCARD;
      assert.equal(
        await provider.closeFile(windowId, leafId, reviewedPath),
        true,
        "the tab closes",
      );
      assert.equal(readFileSync(reviewedPath, "utf-8"), REVIEWED_TARGET, "the edit is discarded");

      await restart();
      const status = await loadedReviewStatus();
      assert.deepEqual(
        [status?.reviewId, status?.unresolvedChunks],
        [reviewId, 1],
        "the discard of the later edit leaves the saved review",
      );
      assert.equal(provider.readMarkdownBufferContent(reviewedPath), REVIEWED_TARGET);
    });

    it("keeps the chunk on the text that it proposed", async function () {
      await show(reviewedPath);
      const { reviewId } = await propose();
      assert.equal((await provider.saveFile(reviewedPath)).ok, true);
      await provider.applyWorkspaceTextEdits([
        { documentPath: reviewedPath, range: { from: 0, to: 0 }, insert: AUTHOR_PREFIX },
      ]);
      messageBoxes.answer = DISCARD;
      assert.equal(await provider.closeFile(windowId, leafId, reviewedPath), true);

      await restart();
      const documentId = provider.ensureDocumentId(reviewedPath);
      const status = await loadedReviewStatus();
      const [sidecar] = await provider.annotationQueries.listCollaborationSidecars();
      const chunk = sidecar?.review?.suggestions[0];
      if (status === undefined || chunk === undefined) {
        assert.fail("the saved review returns with its chunk");
      }
      const rejected = await provider.decideReviewChunk(reviewId, chunk.suggestionId, "reject", {
        expectedReviewGeneration: status.generation,
        expectedWorkingSha256: sha256Text(REVIEWED_TARGET),
      });
      assert.ok(rejected.ok, "the author rejects the chunk");
      assert.equal(
        provider.readMarkdownBufferContent(reviewedPath),
        REVIEWED_SOURCE,
        "the reject removes the proposed text and nothing else",
      );
      assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 0);
    });
  });

  describe("a review that returns from its sidecar when the document loads", function () {
    it("reaches the window with the text that the editor loads", async function () {
      await propose();
      // The quit puts the review of a document that no pane shows in its sidecar.
      await requestQuit();
      await restart();
      const window = new BrowserWindow();

      await provider.getDocument(reviewedPath);

      const sessions = sentMessagesFor(window)
        .filter(([channel]) => channel === "documents-update")
        .map(([, payload]) => payload as { event: DP_EVENTS; context: DocumentsUpdateContext })
        .filter(({ event }) => event === DP_EVENTS.DOCUMENT_COLLABORATION)
        .map(({ context }) => context.collaborationSession);
      window.close();
      assert.deepEqual(
        sessions.map((session) => [session?.workingText, session?.review?.suggestions.length]),
        [[REVIEWED_TARGET, 1]],
        "the one session that the window receives has the text of the review",
      );
    });
  });

  describe("text that the author accepted from a review", function () {
    it("is in the quit prompt for a document that no pane shows, and Save writes it", async function () {
      const { reviewId, generation } = await propose();
      const accepted = await provider.acceptAllReviewChunks(reviewId, {
        expectedReviewGeneration: generation,
        expectedWorkingSha256: sha256Text(REVIEWED_TARGET),
      });
      assert.ok(accepted.ok, "the author accepts the proposal");
      assert.equal(provider.getActiveFile(leafId), undefined, "no pane shows the document");

      messageBoxes.answer = SAVE;
      await requestQuit();

      assert.deepEqual(
        messageBoxes.shown.map((options) => options.detail),
        [reviewedPath],
        "the quit asks about the accepted text",
      );
      assert.equal(appQuitRequests.length, 1, "the quit goes on");
      assert.equal(
        readFileSync(reviewedPath, "utf-8"),
        REVIEWED_TARGET,
        "the accepted text is in the file",
      );
    });

    it("is unsaved text of a closed document at its next load", async function () {
      const { reviewId, generation } = await propose();
      // The quit puts the review of a document that no pane shows in its sidecar.
      await requestQuit();
      await restart();
      assert.deepEqual(provider.loadedDocuments, [], "the document is closed");

      await acceptInAnnotationsView({ reviewId, generation });

      assert.equal(
        (await loadedReviewStatus())?.state,
        "resolved-awaiting-save",
        "the review of the loaded document waits for a save",
      );
      assert.equal(
        provider.readMarkdownBufferContent(reviewedPath),
        REVIEWED_TARGET,
        "the document loads with the accepted text",
      );
      assert.equal(provider.isModified(reviewedPath), true, "the accepted text is unsaved");

      const saved = await provider.saveFile(reviewedPath);
      assert.equal(saved.ok, true, "a save writes the accepted text");
      assert.equal(readFileSync(reviewedPath, "utf-8"), REVIEWED_TARGET);
    });

    it("stays the text of a closed document whose file another program changed (#210)", async function () {
      const review = await propose();
      await requestQuit();
      await restart();
      await acceptInAnnotationsView(review);
      writeFileSync(reviewedPath, CHANGED_ON_DISK, "utf-8");
      const window = new BrowserWindow();

      await provider.getDocument(reviewedPath);

      const kept = sentMessagesFor(window)
        .filter(([channel]) => channel === REMOTE_CHANGE_KEPT_CHANNEL)
        .map(([, payload]) => payload as RemoteChangeKeptBroadcast);
      window.close();
      assert.equal(
        provider.readMarkdownBufferContent(reviewedPath),
        REVIEWED_TARGET,
        "the document loads with the accepted text",
      );
      assert.equal(provider.isModified(reviewedPath), true, "the accepted text is unsaved");
      assert.deepEqual(
        kept,
        [{ filePath: reviewedPath, unsavedChanges: true, frozenReview: true }],
        "the window is told that the file changed on disk and the document kept its text",
      );
      const saved = await provider.saveFile(reviewedPath);
      assert.equal(
        saved.ok ? undefined : saved.refusal.reason,
        "disk-changed",
        "a save does not write over the text of the other program",
      );
      assert.equal(readFileSync(reviewedPath, "utf-8"), CHANGED_ON_DISK);
    });
  });
});

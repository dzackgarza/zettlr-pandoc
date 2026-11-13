/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider removed file specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Another program removes the file of a loaded document.
 *                  The REAL DocumentManager keeps a document whose text is
 *                  not on disk and tells each window what a save does: it
 *                  writes the file again, or, for a document with a review,
 *                  it is refused. An annotation of such a document is kept,
 *                  and a proposal is refused with the cause. A document
 *                  whose text is on disk closes (#210).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { BrowserWindow } from "electron";
import { mkdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import type { DocumentsUpdateContext } from "source/app/service-providers/documents";
import { sha256Text } from "source/common/util/sha256";
import {
  DP_EVENTS,
  FILE_REMOVED_KEPT_CHANNEL,
  type FileRemovedKeptBroadcast,
  REMOTE_CHANGE_KEPT_CHANNEL,
} from "source/types/common/documents";
import { bootDocumentManager, emitWatchdogEvent } from "./documents-provider-seam";
import { sentMessagesFor, userData } from "./headless-electron-harness.cjs";

const SOURCE = "A lattice is a free abelian group with a bilinear form.\n";
const TARGET = SOURCE.replace("bilinear", "symmetric bilinear");
const PREFIX = "Definition. ";
const SIDECARS = path.join(userData, "review-sidecars");

describe("Documents-provider removed file", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;
  let window: BrowserWindow;
  let windowId: string;
  let leafId: string;
  let closedFiles: DocumentsUpdateContext[];

  /** Waits until the watchdog event has run through the provider. */
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 20; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function removedBroadcasts(): FileRemovedKeptBroadcast[] {
    return sentMessagesFor(window)
      .filter(([channel]) => channel === FILE_REMOVED_KEPT_CHANNEL)
      .map(([, payload]) => payload as FileRemovedKeptBroadcast);
  }

  /** Another program removes the file, and the watcher reports it. */
  async function removeOnDisk(): Promise<void> {
    unlinkSync(filePath);
    emitWatchdogEvent("unlink", filePath);
    await settle();
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-removed-file-"));
    filePath = path.join(root, "Lattices.md");
    writeFileSync(filePath, SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    provider = await bootDocumentManager([root]);
    windowId = provider.windowKeys()[0];
    leafId = provider.leafIds(windowId)[0];
    closedFiles = [];
    provider.on(DP_EVENTS.CLOSE_FILE, (...args: unknown[]) => {
      closedFiles.push(args[0] as DocumentsUpdateContext);
    });
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, leafId, filePath), true);
    window = new BrowserWindow();
  });

  afterEach(async function () {
    window.close();
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a document with unsaved text, and a save writes the file again", async function () {
    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
    ]);

    await removeOnDisk();

    assert.deepEqual(closedFiles, [], "no tab of the document closes");
    assert.equal(provider.readMarkdownBufferContent(filePath), `${PREFIX}${SOURCE}`);
    assert.equal(provider.isModified(filePath), true);
    assert.deepEqual(removedBroadcasts(), [{ filePath, saveWritesFile: true }]);

    assert.deepEqual(await provider.saveFile(filePath), { ok: true });
    assert.equal(readFileSync(filePath, "utf-8"), `${PREFIX}${SOURCE}`);
    assert.equal(provider.isModified(filePath), false);

    // The watcher reports the file of the save as a new file. The next
    // change of another program is not that event: the provider handles it.
    emitWatchdogEvent("add", filePath);
    await settle();
    writeFileSync(filePath, TARGET, "utf-8");
    const later = new Date(Date.now() + 10_000);
    utimesSync(filePath, later, later);
    emitWatchdogEvent("change", filePath);
    await settle();
    assert.deepEqual(
      sentMessagesFor(window)
        .filter(([channel]) => channel === REMOTE_CHANGE_KEPT_CHANNEL)
        .map(([, payload]) => payload),
      [{ filePath, unsavedChanges: false, frozenReview: false }],
      "the window hears of the change of the new file",
    );
  });

  it("keeps a document with a review, whose save is refused", async function () {
    const documentId = provider.ensureDocumentId(filePath);
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(SOURCE),
      [
        {
          description: "Name the symmetry",
          patch: createPatch("document", SOURCE, TARGET, "", "", { context: 0 }),
        },
      ],
      "removed-file-proposal",
      0,
    );
    assert.equal(submitted.ok, true, "the proposal opens a review");
    assert.equal(provider.isModified(filePath), true, "the working text holds the proposal");

    await removeOnDisk();

    assert.deepEqual(closedFiles, [], "no tab of the document closes");
    assert.equal(provider.readMarkdownBufferContent(filePath), TARGET);
    assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 1);
    assert.deepEqual(removedBroadcasts(), [{ filePath, saveWritesFile: false }]);

    const saved = await provider.saveFile(filePath);
    if (saved.ok) {
      assert.fail("a save cannot compare a file that is not there with the review");
    }
    assert.equal(saved.refusal.reason, "disk-unreadable");
  });

  it("takes an annotation on a kept document, which a save writes with the file", async function () {
    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
    ]);
    await removeOnDisk();
    const documentId = provider.ensureDocumentId(filePath);

    const created = await provider.createAnnotation(
      documentId,
      "owner",
      PREFIX.length,
      PREFIX.length + 9,
      "Say which group.",
      0,
    );
    if ("ok" in created) {
      assert.fail(`the annotation is refused: ${created.message}`);
    }
    assert.equal(created.messages[0].text, "Say which group.");

    assert.deepEqual(await provider.saveFile(filePath), { ok: true });
    assert.equal(readFileSync(filePath, "utf-8"), `${PREFIX}${SOURCE}`);
    assert.deepEqual(
      provider.annotationQueries
        .getAnnotations(documentId)
        .items.map((item) => item.messages[0].text),
      ["Say which group."],
      "the annotation stays with the saved file",
    );
  });

  it("refuses a proposal for a kept document with the cause", async function () {
    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
    ]);
    await removeOnDisk();
    const documentId = provider.ensureDocumentId(filePath);
    const working = `${PREFIX}${SOURCE}`;

    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(working),
      [
        {
          description: "Name the symmetry",
          patch: createPatch("document", working, `${PREFIX}${TARGET}`, "", "", { context: 0 }),
        },
      ],
      "removed-file-proposal",
      0,
    );
    if (submitted.ok) {
      assert.fail("a review needs the file that its proposals are compared with");
    }
    assert.equal(submitted.code, "DOCUMENT_UNREADABLE");
    assert.equal(provider.readMarkdownBufferContent(filePath), working, "the text stays");
  });

  it("closes a document whose text is on disk", async function () {
    await removeOnDisk();

    assert.deepEqual(
      closedFiles.map((context) => context.filePath),
      [filePath],
    );
    assert.deepEqual(removedBroadcasts(), [], "no text is kept, so there is no message");
    assert.equal(provider.readMarkdownBufferContent(filePath), undefined);
  });

  it("keeps the renamed document when the unlink of the file that the rename replaced is late (#210)", async function () {
    // The document whose file the rename replaces has an annotation, so its
    // close writes the sidecar before the tabs close.
    const replacedId = provider.ensureDocumentId(filePath);
    const created = await provider.createAnnotation(replacedId, "owner", 2, 9, "Which lattice?", 0);
    if ("ok" in created) {
      assert.fail(`the annotation is refused: ${created.message}`);
    }
    const renamedPath = path.join(root, "Groups.md");
    const RENAMED = "A group is a set with an associative operation.\n";
    writeFileSync(renamedPath, RENAMED, "utf-8");
    await provider.getDocument(renamedPath);
    assert.equal(await provider.openFile(windowId, leafId, renamedPath), true);

    // A rename over an existing file (file-rename.ts) moves that file to the
    // trash and then renames. When more than 100 ms pass between the two,
    // chokidar reports `unlink` for the replaced path before the rename;
    // the provider is still closing that document when the rename and
    // `hasMovedFile` run.
    unlinkSync(filePath);
    emitWatchdogEvent("unlink", filePath);
    renameSync(renamedPath, filePath);
    await provider.hasMovedFile(renamedPath, filePath);
    await settle();

    assert.equal(
      provider.readMarkdownBufferContent(filePath),
      RENAMED,
      "the renamed document is loaded at its new path",
    );
    assert.equal(provider.getActiveFile(leafId), filePath, "its tab stays open");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider identity specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager through the transitions
 *                  that change where a document is or whether it is loaded:
 *                  a rename of the file, a rename of its folder, a move onto
 *                  the path of another document, and the release of a
 *                  document that a refused proposal loaded. After each one
 *                  the id of a document names its path, its collaboration
 *                  state is at that path, and a close or a quit is not
 *                  refused (#178).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { DocumentTree } from "source/app/service-providers/documents/document-tree";
import { ReviewStateNotMovedError } from "source/app/service-providers/documents/review-state-not-moved-error";
import { canonicalPath } from "source/app/util/real-path";
import { sha256Text } from "source/common/util/sha256";
import { stringify as stringifyYAML } from "yaml";
import { bootDocumentManager, emitWatchdogEvent } from "./documents-provider-seam";
import { appListeners, appQuitRequests, userData } from "./headless-electron-harness.cjs";

const SOURCE = "An even unimodular lattice has a rank that 8 divides.\n";
const ANNOTATED = "even unimodular";
const REVISED = SOURCE.replace("rank", "signature");

/** The annotation ids and the review id of each sidecar, by document path. */
async function sidecarStates(
  provider: DocumentManager,
): Promise<Map<string, { annotations: string[]; review: string | null }>> {
  const sidecars = await provider.annotationQueries.listCollaborationSidecars();
  return new Map(
    sidecars.map((sidecar) => [
      sidecar.documentPath,
      {
        annotations: sidecar.annotations.items.map((item) => item.annotationId),
        review: sidecar.review === null ? null : sidecar.review.reviewId,
      },
    ]),
  );
}

describe("Documents-provider identity of a moved document", function () {
  let root: string;
  let provider: DocumentManager;
  let windowId: string;

  beforeEach(async function () {
    // The real path: the application names a file with each symbolic link resolved.
    root = realpathSync(await mkdtemp(path.join(tmpdir(), "zettlr-move-identity-")));
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(path.join(userData, "review-sidecars"), { recursive: true, force: true });
    appListeners.delete("before-quit");
    appQuitRequests.length = 0;

    provider = await bootDocumentManager([root]);
    windowId = provider.windowKeys()[0];
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  /** The one pane of the window. The provider makes a new one when the last tab closes. */
  function pane(): string {
    const leaves = provider.leafIds(windowId);
    assert.equal(leaves.length, 1, "the window has one pane");
    return leaves[0];
  }

  function write(...segments: string[]): string {
    const filePath = path.join(root, ...segments);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, SOURCE, "utf-8");
    return filePath;
  }

  /** Opens the file in the pane and gives it one annotation. */
  async function openAndAnnotate(filePath: string): Promise<{ id: string; annotation: string }> {
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

  /** An agent proposes a change to a file that no pane shows. */
  async function proposeWithoutPane(filePath: string, baseline: string): Promise<string> {
    const id = provider.ensureDocumentId(filePath);
    const submitted = await provider.submitProposal(
      id,
      sha256Text(baseline),
      [
        {
          description: "Name the signature",
          patch: createPatch("document", SOURCE, REVISED, "", "", { context: 0 }),
        },
      ],
      `proposal-${path.basename(filePath)}`,
      0,
    );
    return submitted.ok ? submitted.reviewId : submitted.code;
  }

  /** Fires the before-quit listener and waits until the provider asks for the quit. */
  async function requestQuit(): Promise<number> {
    const listeners = appListeners.get("before-quit");
    if (listeners?.length !== 1) {
      assert.fail("the provider registers the one before-quit listener");
    }
    const event = { prevented: false, preventDefault: () => {} };
    event.preventDefault = () => {
      event.prevented = true;
    };
    listeners[0](event);
    const deadline = Date.now() + 5000;
    while (event.prevented && appQuitRequests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return appQuitRequests.length;
  }

  it("keeps the id, the working text and the annotations of a renamed open document", async function () {
    const oldPath = write("note.md");
    const newPath = path.join(root, "lattices.md");
    const { id, annotation } = await openAndAnnotate(oldPath);

    renameSync(oldPath, newPath);
    await provider.hasMovedFile(oldPath, newPath);
    // The watcher reports the old path as removed after an in-app rename.
    emitWatchdogEvent("unlink", oldPath);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(provider.getDocumentId(newPath), id, "the id names the new path");
    assert.equal(provider.getDocumentPath(id), newPath);
    assert.equal(provider.getDocumentId(oldPath), undefined, "no document is at the old path");
    assert.equal(provider.readWorkingText(id), SOURCE, "the working text resolves through the id");

    const second = await provider.createAnnotation(
      id,
      "owner",
      0,
      2,
      "Which lattices?",
      provider.annotationQueries.getAnnotations(id).generation,
    );
    if ("ok" in second) {
      assert.fail(`The renamed document refused an annotation: ${second.code}`);
    }

    assert.equal(await provider.closeFile(windowId, pane(), newPath), true, "the tab closes");
    assert.equal(provider.loadedDocuments.length, 0, "the close unloads the document");
    assert.deepEqual(
      await sidecarStates(provider),
      new Map([[newPath, { annotations: [annotation, second.annotationId], review: null }]]),
    );
  });

  it("quits with a reviewed document that no pane shows, in a renamed folder", async function () {
    const oldPath = write("drafts", "genus.md");
    const newPath = path.join(root, "papers", "genus.md");
    const reviewId = await proposeWithoutPane(oldPath, SOURCE);
    const id = provider.getDocumentId(oldPath);
    assert.ok(id !== undefined, "the proposal loaded the document");
    assert.equal(provider.reviewStatus(id)?.unresolvedChunks, 1);

    renameSync(path.dirname(oldPath), path.dirname(newPath));
    await provider.hasMovedDir(path.dirname(oldPath), path.dirname(newPath));

    assert.equal(provider.getDocumentPath(id), newPath);
    assert.equal(provider.readWorkingText(id), REVISED);
    assert.equal(await requestQuit(), 1, "the quit is not refused");
    assert.equal(provider.loadedDocuments.length, 0, "the close unloads the document");
    assert.deepEqual(
      await sidecarStates(provider),
      new Map([[newPath, { annotations: [], review: reviewId }]]),
    );
    assert.equal(readFileSync(newPath, "utf-8"), SOURCE, "the proposal is not on disk");
  });

  it("carries the sidecar of a closed document through a rename of the file and of its folder", async function () {
    const first = write("closed.md");
    const second = write("drafts", "closed.md");
    const firstState = await openAndAnnotate(first);
    assert.equal(await provider.closeFile(windowId, pane(), first), true);
    const secondState = await openAndAnnotate(second);
    assert.equal(await provider.closeFile(windowId, pane(), second), true);
    assert.equal(provider.loadedDocuments.length, 0, "the close unloads the document");

    const firstMoved = path.join(root, "renamed.md");
    const secondMoved = path.join(root, "papers", "closed.md");
    renameSync(first, firstMoved);
    await provider.hasMovedFile(first, firstMoved);
    renameSync(path.dirname(second), path.dirname(secondMoved));
    await provider.hasMovedDir(path.dirname(second), path.dirname(secondMoved));

    assert.deepEqual(
      await sidecarStates(provider),
      new Map([
        [firstMoved, { annotations: [firstState.annotation], review: null }],
        [secondMoved, { annotations: [secondState.annotation], review: null }],
      ]),
    );
    assert.equal(provider.getDocumentPath(firstState.id), firstMoved);
    assert.equal(provider.getDocumentPath(secondState.id), secondMoved);

    await provider.getDocument(secondMoved);
    assert.deepEqual(
      provider.annotationQueries
        .getAnnotations(secondState.id)
        .items.map((item) => [item.annotationId, item.anchor.state]),
      [[secondState.annotation, "range"]],
      "the annotation is on its text when the moved document opens",
    );
  });

  it("moves each document of a renamed folder when no sidecar can be written", async function () {
    const first = write("drafts", "genus.md");
    const second = write("drafts", "lattices.md");
    const firstState = await openAndAnnotate(first);
    const secondState = await openAndAnnotate(second);
    const movedDirectory = path.join(root, "papers");

    // The directory of the sidecars takes no new file: no state can go to
    // the key of a new path.
    const sidecars = path.join(userData, "review-sidecars");
    chmodSync(sidecars, 0o500);
    renameSync(path.dirname(first), movedDirectory);
    await assert
      .rejects(
        provider.hasMovedDir(path.dirname(first), movedDirectory),
        (failure) =>
          failure instanceof ReviewStateNotMovedError &&
          failure.documentPaths.join() ===
            [
              path.join(movedDirectory, "genus.md"),
              path.join(movedDirectory, "lattices.md"),
            ].join(),
        "one error names the two documents whose state stayed",
      )
      .finally(() => chmodSync(sidecars, 0o700));

    assert.deepEqual(
      [provider.getDocumentPath(firstState.id), provider.getDocumentPath(secondState.id)],
      [path.join(movedDirectory, "genus.md"), path.join(movedDirectory, "lattices.md")],
      "each document is at its path in the renamed folder",
    );
  });

  it("replaces the document at the target of a move, with its collaboration state", async function () {
    const replaced = write("target.md");
    const moving = write("source.md");
    await openAndAnnotate(replaced);
    await provider.getDocument(moving);
    assert.equal(await provider.openFile(windowId, pane(), moving, true), true);
    const movingId = provider.getDocumentId(moving);

    renameSync(moving, replaced);
    await provider.hasMovedFile(moving, replaced);

    assert.deepEqual(
      provider.loadedDocuments.map((document) => [document.filePath, document.documentId]),
      [[replaced, movingId]],
      "one document is at the target: the one that moved there",
    );
    assert.equal(provider.getDocumentId(replaced), movingId);
    assert.deepEqual(
      await sidecarStates(provider),
      new Map(),
      "the annotations of the replaced file went with the file",
    );
    assert.equal(await provider.closeFile(windowId, pane(), replaced), true);
    assert.equal(provider.loadedDocuments.length, 0, "the close unloads the document");
  });

  it("keeps the moved document when the watcher events of the rename arrive after the move", async function () {
    const replaced = write("target.md");
    const moving = write("source.md");
    await provider.getDocument(replaced);
    assert.equal(await provider.openFile(windowId, pane(), replaced), true);
    await provider.getDocument(moving);
    assert.equal(await provider.openFile(windowId, pane(), moving, true), true);
    const movingId = provider.getDocumentId(moving);

    renameSync(moving, replaced);
    await provider.hasMovedFile(moving, replaced);
    // The watcher reports a rename over a watched file as a removal of the
    // source and a change of the target (test/fsal-watcher-events.spec.ts).
    emitWatchdogEvent("unlink", moving);
    emitWatchdogEvent("change", replaced);
    for (let tick = 0; tick < 20; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(
      provider.loadedDocuments.map((document) => [document.filePath, document.documentId]),
      [[replaced, movingId]],
      "the moved document stays loaded at the target",
    );
    assert.equal(
      provider.isModified(replaced),
      false,
      "the moved document has the text of its file",
    );
    assert.equal(
      await provider.closeFile(windowId, pane(), replaced),
      true,
      "the pane still has the tab of the moved document",
    );
  });

  it("holds no collaboration state for a document that a refused proposal loaded and released", async function () {
    const filePath = write("annotated.md");
    const { id, annotation } = await openAndAnnotate(filePath);
    assert.equal(await provider.closeFile(windowId, pane(), filePath), true);

    assert.equal(
      await proposeWithoutPane(filePath, "not the text of the file"),
      "REVISION_MISMATCH",
      "the proposal is refused",
    );

    assert.deepEqual(provider.loadedDocuments, [], "the refused proposal leaves no document");
    assert.deepEqual(
      provider.annotationQueries.getAnnotations(id).items,
      [],
      "a document that is not loaded has no collaboration state in memory",
    );
    assert.deepEqual(
      await sidecarStates(provider),
      new Map([[filePath, { annotations: [annotation], review: null }]]),
    );
  });

  /** Opens `filePath` in the pane as a window does: the editor loads the document of the tab. */
  async function openInPane(filePath: string): Promise<string> {
    assert.equal(await provider.openFile(windowId, pane(), filePath), true);
    const tabPath = provider.getActiveFile(pane());
    assert.ok(tabPath !== undefined, "the pane shows a tab");
    await provider.getDocument(tabPath);
    return tabPath;
  }

  /** A folder of the workspace and a symbolic link to it: each file in it has two names. */
  function linkedFolder(): { real: string; alias: string } {
    const real = write("chapters", "genus.md");
    symlinkSync(path.join(root, "chapters"), path.join(root, "book"));
    return { real, alias: path.join(root, "book", "genus.md") };
  }

  it("reattaches the annotations of a file that opens under its other name (#57)", async function () {
    const { real, alias } = linkedFolder();
    const aliasTab = await openInPane(alias);
    const [annotated] = provider.loadedDocuments;
    const from = SOURCE.indexOf(ANNOTATED);
    const created = await provider.createAnnotation(
      annotated.documentId,
      "owner",
      from,
      from + ANNOTATED.length,
      "State the indefinite case.",
      provider.annotationQueries.getAnnotations(annotated.documentId).generation,
    );
    if ("ok" in created) {
      assert.fail(`The annotation was refused: ${created.code}`);
    }
    assert.equal(await provider.closeFile(windowId, pane(), aliasTab), true);
    assert.equal(provider.loadedDocuments.length, 0, "the close unloads the document");

    await openInPane(real);

    assert.deepEqual(
      provider.loadedDocuments.map((document) => [
        document.filePath,
        provider.annotationQueries
          .getAnnotations(document.documentId)
          .items.map((item) => [item.annotationId, item.anchor.state]),
      ]),
      [[real, [[created.annotationId, "range"]]]],
      "the document of the file has the annotation that was made under its other name",
    );
  });

  it("shows the proposal of an agent in the tab of the file under its other name (#57)", async function () {
    const { real, alias } = linkedFolder();
    await openInPane(alias);

    // The Agent API names the document of a submission with each symbolic
    // link resolved (`handleReviewSubmission`).
    const reviewId = await proposeWithoutPane(await canonicalPath(alias), SOURCE);

    assert.deepEqual(
      provider.loadedDocuments.map((document) => [
        document.filePath,
        provider.reviewQueries.getReview(document.documentId)?.reviewId,
      ]),
      [[real, reviewId]],
      "one document holds the file: the document of the tab, with the review",
    );
    assert.deepEqual(
      (await provider.reviewQueries.listReviewQueries()).map((query) =>
        query.attached ? [true, query.documentPath] : [false, query.sidecar.documentPath],
      ),
      [[true, real]],
      "the review is attached, and it is not also listed as the review of a closed document",
    );
  });

  it("restores a stored tab under the name of its file (#57)", async function () {
    const { real, alias } = linkedFolder();
    await provider.shutdown();
    // A tab that an earlier version stored under the other name of its file.
    const stored = new DocumentTree();
    stored.getAllLeafs()[0].tabMan.openFile(alias);
    writeFileSync(
      path.join(userData, "documents.yaml"),
      stringifyYAML({ stored: stored.toJSON() }),
      "utf-8",
    );

    provider = await bootDocumentManager([root]);
    windowId = provider.windowKeys()[0];

    assert.equal(provider.getActiveFile(pane()), real, "the tab names the file by its real path");
  });
});

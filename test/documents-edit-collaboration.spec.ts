/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider edits of a document with annotations
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager through its two paths
 *                  that change the text of a loaded document: the update
 *                  that an editor pushes, and a workspace edit (reference
 *                  rename, Fix All). An annotation stays on its text through
 *                  both, and the review sidecar holds the text that the
 *                  document has after a workspace edit. A workspace edit
 *                  that is rolled back leaves the annotation where it was
 *                  (#146).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { ChangeSet } from "@codemirror/state";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import EventEmitter from "events";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { collaborationSidecarFilePath } from "source/app/service-providers/documents/collaboration-sidecar-store";
import LogProvider from "source/app/service-providers/log";
import ReferenceProvider from "source/app/service-providers/references";
import { runWorkspaceEditTransaction } from "source/app/service-providers/references/workspace-edit-transaction";
import { hashDocumentSource } from "source/common/pandoc-util/extract-references";
import { sha256Text } from "source/common/util/sha256";
import type { AnnotationAnchor } from "source/types/common/annotation-domain";
import { bootDocumentManager } from "./documents-provider-seam";
import { appListeners, userData } from "./headless-electron-harness.cjs";
import { invokeMain } from "./main-ipc";

const SOURCE = "A lattice is a free abelian group with a bilinear form.\n";
const TARGET_TEXT = "bilinear form";
const PREFIX = "Definition. ";
const PROPOSED = SOURCE.replace("bilinear", "symmetric bilinear");
const SIDECARS = path.join(userData, "review-sidecars");

describe("Documents-provider edits of a document with annotations", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;
  let documentId: string;

  /** The owner annotates `TARGET_TEXT` and gets the place of the annotation. */
  async function annotate(): Promise<{ from: number; to: number }> {
    const from = SOURCE.indexOf(TARGET_TEXT);
    const to = from + TARGET_TEXT.length;
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      from,
      to,
      "Which form?",
      0,
    );
    assert.ok("annotationId" in created, "the owner creates the annotation");
    return { from, to };
  }

  function anchors(): AnnotationAnchor[] {
    return provider.annotationQueries.getAnnotations(documentId).items.map((item) => item.anchor);
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-edit-collaboration-"));
    filePath = path.join(root, "Lattice.md");
    writeFileSync(filePath, SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    await rm(SIDECARS, { recursive: true, force: true });
    appListeners.delete("before-quit");

    provider = await bootDocumentManager([root]);
    await provider.getDocument(filePath);
    documentId = provider.ensureDocumentId(filePath);
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps an annotation on its text when an editor inserts text before it", async function () {
    const { from, to } = await annotate();
    const { startVersion } = await provider.getDocument(filePath);

    const accepted = await invokeMain("documents-authority", {
      command: "push-updates",
      payload: {
        filePath,
        version: startVersion,
        updates: [
          {
            clientID: "editor-under-test",
            changes: ChangeSet.of({ from: 0, insert: PREFIX }, SOURCE.length).toJSON(),
          },
        ],
      },
    });

    assert.equal(accepted, true, "the provider takes the update of the editor");
    assert.equal(provider.readMarkdownBufferContent(filePath), `${PREFIX}${SOURCE}`);
    assert.deepEqual(anchors(), [
      {
        state: "range",
        from: from + PREFIX.length,
        to: to + PREFIX.length,
        quotedText: TARGET_TEXT,
      },
    ]);
  });

  it("keeps an annotation on its text when a workspace edit inserts text before it", async function () {
    const { from, to } = await annotate();

    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
    ]);

    assert.equal(provider.readMarkdownBufferContent(filePath), `${PREFIX}${SOURCE}`);
    assert.deepEqual(anchors(), [
      {
        state: "range",
        from: from + PREFIX.length,
        to: to + PREFIX.length,
        quotedText: TARGET_TEXT,
      },
    ]);
  });

  it("puts the text after a workspace edit of a reviewed document in the review sidecar", async function () {
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(SOURCE),
      [
        {
          description: "Name the symmetry",
          patch: createPatch("document", SOURCE, PROPOSED, "", "", { context: 0 }),
        },
      ],
      "edit-collaboration-proposal",
      0,
    );
    assert.ok(submitted.ok, "the agent submits the proposal");

    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
    ]);

    const sidecars = await provider.annotationQueries.listCollaborationSidecars();
    assert.deepEqual(
      sidecars.map((sidecar) => sidecar.workingText),
      [`${PREFIX}${PROPOSED}`],
      "the sidecar holds the edit and the proposal",
    );
    assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 1);
  });

  it("has each editor update that it took after a review decision in the sidecar file (#57)", async function () {
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(SOURCE),
      [
        {
          description: "Name the symmetry",
          patch: createPatch("document", SOURCE, PROPOSED, "", "", { context: 0 }),
        },
      ],
      "edit-after-decision-proposal",
      0,
    );
    if (!submitted.ok) {
      assert.fail(`The review proposal was refused: ${submitted.code}`);
    }
    const decided = await provider.acceptAllReviewChunks(submitted.reviewId, {
      expectedReviewGeneration: submitted.reviewGeneration,
      expectedWorkingSha256: sha256Text(PROPOSED),
    });
    assert.ok(decided.ok, "the author accepts the proposal");
    const sidecarFile = collaborationSidecarFilePath(SIDECARS, filePath);
    const onDisk = (): string => JSON.parse(readFileSync(sidecarFile, "utf-8")).workingText;

    let { startVersion: version } = await provider.getDocument(filePath);
    let text = PROPOSED;
    for (const insert of ["Definition. ", "(Bourbaki) "]) {
      const accepted = await invokeMain("documents-authority", {
        command: "push-updates",
        payload: {
          filePath,
          version,
          updates: [
            {
              clientID: "editor-under-test",
              changes: ChangeSet.of({ from: 0, insert }, text.length).toJSON(),
            },
          ],
        },
      });
      assert.equal(accepted, true, "the provider takes the update of the editor");
      text = `${insert}${text}`;
      version += 1;
      // The file is what a start after a crash reads: no quit wrote it.
      assert.equal(onDisk(), text, "the sidecar file has the update when the provider takes it");
    }
  });

  it("restores the sidecar of a reviewed document when the app stopped during a workspace edit (#210)", async function () {
    await annotate();
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(SOURCE),
      [
        {
          description: "Name the symmetry",
          patch: createPatch("document", SOURCE, PROPOSED, "", "", { context: 0 }),
        },
      ],
      "edit-collaboration-proposal",
      0,
    );
    assert.ok(submitted.ok, "the agent submits the proposal");
    const collaborationState = async (manager: DocumentManager) =>
      (await manager.annotationQueries.listCollaborationSidecars()).map((sidecar) => ({
        workingText: sidecar.workingText,
        suggestionAnchors: sidecar.review?.suggestions.map((suggestion) => suggestion.anchors),
        annotationAnchors: sidecar.annotations.items.map((item) => item.anchor),
      }));
    const beforeEdit = await collaborationState(provider);
    assert.equal(beforeEdit[0]?.workingText, PROPOSED, "the buffer holds the proposal");

    // The app stops after the reviewed buffer took its edit and before the
    // transaction ends: the journal is the one that the transaction wrote.
    const journalFile = path.join(root, "workspace-edit-journal.json");
    let journalAtStop: string | undefined;
    const stopping = {
      readMarkdownBufferContent: (file: string) => provider.readMarkdownBufferContent(file),
      applyWorkspaceTextEdits: async (
        edits: Parameters<DocumentManager["applyWorkspaceTextEdits"]>[0],
      ) => {
        const updated = await provider.applyWorkspaceTextEdits(edits);
        journalAtStop = readFileSync(journalFile, "utf-8");
        return updated;
      },
    };
    const insideTarget = PROPOSED.indexOf(TARGET_TEXT) + "bilinear".length;
    await runWorkspaceEditTransaction(stopping, root, {
      edits: [
        { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
        { documentPath: filePath, range: { from: insideTarget, to: insideTarget }, insert: "," },
      ],
      expectedSourceHashes: { [filePath]: hashDocumentSource(PROPOSED) },
    });
    assert.ok(journalAtStop !== undefined, "the transaction wrote its journal");
    await provider.shutdown();
    writeFileSync(journalFile, journalAtStop, "utf-8");

    // The next start: the references provider recovers the journal before a
    // document loads.
    provider = await bootDocumentManager([root]);
    const references = new ReferenceProvider(
      new LogProvider(),
      new EventEmitter(),
      provider,
      () => 500,
      root,
      {
        schedule: (callback: () => void) => {
          callback();
          return { cancel: () => {} };
        },
      },
    );
    await references.boot();
    await references.shutdown();

    assert.deepEqual(
      await collaborationState(provider),
      beforeEdit,
      "the sidecar has the text and the anchors of the document before the transaction",
    );
    await provider.getDocument(filePath);
    assert.equal(provider.readMarkdownBufferContent(filePath), PROPOSED);
    assert.equal(provider.reviewStatus(provider.ensureDocumentId(filePath))?.unresolvedChunks, 1);
  });

  it("leaves an annotation where it was when a workspace edit is rolled back", async function () {
    const { from, to } = await annotate();
    const insideTarget = from + "bilinear".length;
    // The transaction cannot install its edit of this closed file.
    const closedPath = path.join(root, "Closed.md");
    const closedSource = "A closed document.\n";
    writeFileSync(closedPath, closedSource, "utf-8");
    chmodSync(closedPath, 0o444);

    await assert.rejects(
      runWorkspaceEditTransaction(provider, root, {
        edits: [
          { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
          { documentPath: filePath, range: { from: insideTarget, to: insideTarget }, insert: "," },
          { documentPath: closedPath, range: { from: 0, to: 0 }, insert: PREFIX },
        ],
        expectedSourceHashes: {
          [filePath]: hashDocumentSource(SOURCE),
          [closedPath]: hashDocumentSource(closedSource),
        },
      }),
    );

    assert.equal(provider.readMarkdownBufferContent(filePath), SOURCE, "the buffer is restored");
    assert.deepEqual(anchors(), [{ state: "range", from, to, quotedText: TARGET_TEXT }]);
  });

  it("keeps the text that the author types while a workspace edit is rolled back", async function () {
    const typed = "Compare the genus.\n";
    const closedPath = path.join(root, "Closed.md");
    const closedSource = "A closed document.\n";
    writeFileSync(closedPath, closedSource, "utf-8");
    chmodSync(closedPath, 0o444);

    // The editor sends the typed text when the transaction has checked the
    // buffer and writes the closed file: the update arrives during that
    // write, as an update of the editor arrives between two steps of the
    // main process.
    let typing: Promise<unknown> | undefined;
    async function type(current: string): Promise<void> {
      const { startVersion } = await provider.getDocument(filePath);
      const accepted = await invokeMain("documents-authority", {
        command: "push-updates",
        payload: {
          filePath,
          version: startVersion,
          updates: [
            {
              clientID: "editor-under-test",
              changes: ChangeSet.of(
                { from: current.length, insert: typed },
                current.length,
              ).toJSON(),
            },
          ],
        },
      });
      assert.equal(accepted, true, "the provider takes the update of the editor");
    }
    const authority = {
      readMarkdownBufferContent: (file: string) => {
        const current = provider.readMarkdownBufferContent(file);
        if (typing === undefined && file === filePath && current?.startsWith(PREFIX) === true) {
          typing = type(current);
        }
        return current;
      },
      applyWorkspaceTextEdits: (edits: Parameters<DocumentManager["applyWorkspaceTextEdits"]>[0]) =>
        provider.applyWorkspaceTextEdits(edits),
    };

    await assert.rejects(
      runWorkspaceEditTransaction(authority, root, {
        edits: [
          { documentPath: filePath, range: { from: 0, to: 0 }, insert: PREFIX },
          { documentPath: closedPath, range: { from: 0, to: 0 }, insert: PREFIX },
        ],
        expectedSourceHashes: {
          [filePath]: hashDocumentSource(SOURCE),
          [closedPath]: hashDocumentSource(closedSource),
        },
      }),
    );

    await typing;
    assert.equal(
      provider.readMarkdownBufferContent(filePath),
      `${SOURCE}${typed}`,
      "the rollback removes the edit of the transaction and keeps the typed text",
    );
  });
});

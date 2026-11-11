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
 *                  document has after a workspace edit (#146).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { ChangeSet } from "@codemirror/state";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { mkdirSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { sha256Text } from "source/common/util/sha256";
import type { AnnotationAnchor } from "source/types/common/annotation-domain";
import { bootDocumentManager } from "./documents-provider-seam";
import { appListeners, ipcMainHandlers, userData } from "./headless-electron-harness.cjs";

type AuthorityHandler = (event: undefined, message: unknown) => Promise<unknown>;

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

    provider = await bootDocumentManager(root);
    await provider.getDocument(filePath);
    documentId = provider.ensureDocumentId(filePath);
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps an annotation on its text when an editor inserts text before it", async function () {
    const { from, to } = await annotate();
    const authority = ipcMainHandlers.get("documents-authority") as AuthorityHandler | undefined;
    assert.ok(authority !== undefined, "the provider answers its editors");
    const { startVersion } = await provider.getDocument(filePath);

    const accepted = await authority(undefined, {
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
});

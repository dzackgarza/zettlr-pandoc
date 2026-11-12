/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider close of a workspace specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager through the close of one
 *                  of two nested workspaces. A document that the other open
 *                  workspace still holds stays open with its unsaved text,
 *                  and the prompt does not ask about it. A document that no
 *                  other workspace holds is asked about and closes (#210).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { bootDocumentManager } from "./documents-provider-seam";
import { messageBoxes, userData } from "./headless-electron-harness.cjs";

const OUTER = "An even unimodular lattice has a rank that 8 divides.\n";
const INNER = "Two lattices in one genus are isometric over each localization.\n";
const DRAFT = "Draft: ";
// The second button of the close prompt: discard the unsaved text.
const DISCARD = 1;

describe("Documents-provider close of a workspace inside a workspace", function () {
  let root: string;
  let inner: string;
  let outerPath: string;
  let innerPath: string;
  let provider: DocumentManager;
  let windowId: string;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-close-workspace-"));
    inner = path.join(root, "genus");
    mkdirSync(inner);
    outerPath = path.join(root, "unimodular.md");
    innerPath = path.join(inner, "genus.md");
    writeFileSync(outerPath, OUTER, "utf-8");
    writeFileSync(innerPath, INNER, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;

    provider = await bootDocumentManager(root, {
      citeproc: { synchronizeDatabases: async (_libraries: string[]) => {} },
      workspaces: [root, inner],
    });
    windowId = provider.windowKeys()[0];
    const [leaf] = provider.leafIds(windowId);
    for (const filePath of [outerPath, innerPath]) {
      await provider.getDocument(filePath);
      assert.equal(await provider.openFile(windowId, leaf, filePath), true);
      await provider.applyWorkspaceTextEdits([
        { documentPath: filePath, range: { from: 0, to: 0 }, insert: DRAFT },
      ]);
      assert.equal(provider.isModified(filePath), true, "the document has unsaved text");
    }
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  /** Closes the workspace `workspace`; a refused close would run the close again. */
  async function closeWorkspace(workspace: string): Promise<boolean> {
    return await provider.closeDocumentsInside([workspace], async () => {
      assert.fail("no close is refused with an action");
    });
  }

  it("keeps each document of an inner workspace that closes, while the outer one holds it", async function () {
    assert.equal(await closeWorkspace(inner), true);
    assert.deepEqual(messageBoxes.shown, [], "no document is asked about");
    assert.equal(provider.isDocumentOpen(innerPath), true, "the outer workspace holds it");
    assert.equal(provider.isModified(innerPath), true, "with its unsaved text");
    assert.equal(provider.isDocumentOpen(outerPath), true);
  });

  it("closes the documents of an outer workspace, and keeps those of the inner one", async function () {
    messageBoxes.answer = DISCARD;
    assert.equal(await closeWorkspace(root), true);
    assert.deepEqual(
      messageBoxes.shown.map((box) => box.detail),
      ["File: unimodular.md"],
      "the prompt asks about the document that closes",
    );
    assert.equal(provider.isDocumentOpen(outerPath), false, "the document closes");
    assert.equal(readFileSync(outerPath, "utf-8"), OUTER, "the answer Discard writes nothing");
    assert.equal(provider.isDocumentOpen(innerPath), true, "the inner workspace holds it");
    assert.equal(provider.isModified(innerPath), true, "with its unsaved text");
  });
});

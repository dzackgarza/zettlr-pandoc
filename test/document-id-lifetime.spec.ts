/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document id lifetime specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager. A workspace listing of
 *                  the Agent API names each file with a document id
 *                  (`ensureDocumentId`). The id of a path stays while the
 *                  application can name the path: a file on disk in an open
 *                  workspace, a loaded document, a tab. When the file is
 *                  removed or its workspace closes, the id goes, so the ids
 *                  of a session follow the files that exist and not each
 *                  file that a listing ever named (#57, PR #55 thread YYkPZ).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import {
  bootDocumentManager,
  emitWatchdogEvent,
  publishFsalEvents,
} from "./documents-provider-seam";
import { messageBoxes, userData } from "./headless-electron-harness.cjs";

// The second button of the close prompt: discard the unsaved text.
const DISCARD = 1;

describe("Document ids of the files that exist (#57)", function () {
  let root: string;
  let other: string;
  let provider: DocumentManager;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-document-ids-"));
    other = await mkdtemp(path.join(tmpdir(), "zettlr-document-ids-other-"));
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;
    provider = await bootDocumentManager([root, other]);
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });

  /** Writes a file and names it as a workspace listing does. */
  function listedFile(filePath: string): string {
    writeFileSync(filePath, "A lattice is even when each norm is even.\n", "utf-8");
    return provider.ensureDocumentId(filePath);
  }

  /** The path that an id names, and the id that the path has. */
  function naming(documentId: string, filePath: string): [string | undefined, string | undefined] {
    return [provider.getDocumentPath(documentId), provider.getDocumentId(filePath)];
  }

  it("forgets the id of a closed file and of each file of a folder that the disk lost", async function () {
    const lone = path.join(root, "lone.md");
    const folder = path.join(root, "genus");
    mkdirSync(folder);
    const inFolder = path.join(folder, "genus.md");
    const kept = path.join(root, "kept.md");
    const loneId = listedFile(lone);
    const inFolderId = listedFile(inFolder);
    const keptId = listedFile(kept);

    unlinkSync(lone);
    rmSync(folder, { recursive: true });
    publishFsalEvents([
      { event: "unlink", path: lone },
      { event: "unlink", path: inFolder },
      { event: "unlinkDir", path: folder },
    ]);

    assert.deepEqual(
      { lone: naming(loneId, lone), inFolder: naming(inFolderId, inFolder) },
      { lone: [undefined, undefined], inFolder: [undefined, undefined] },
    );
    assert.deepEqual(naming(keptId, kept), [kept, keptId], "a file on disk keeps its id");
  });

  it("keeps the id of a document whose unsaved text outlives its file, until it closes", async function () {
    const draft = path.join(root, "draft.md");
    const draftId = listedFile(draft);
    const windowId = provider.windowKeys()[0];
    const [leafId] = provider.leafIds(windowId);
    await provider.getDocument(draft);
    assert.equal(await provider.openFile(windowId, leafId, draft), true);
    await provider.applyWorkspaceTextEdits([
      { documentPath: draft, range: { from: 0, to: 0 }, insert: "Draft: " },
    ]);

    unlinkSync(draft);
    emitWatchdogEvent("unlink", draft);
    publishFsalEvents([{ event: "unlink", path: draft }]);
    assert.deepEqual(naming(draftId, draft), [draft, draftId], "the open document keeps its id");

    messageBoxes.answer = DISCARD;
    assert.equal(await provider.closeFile(windowId, leafId, draft), true);
    assert.deepEqual(naming(draftId, draft), [undefined, undefined]);
  });

  it("forgets the ids of a workspace that closes, and keeps those of the open one", async function () {
    const closing = path.join(other, "closing.md");
    const staying = path.join(root, "staying.md");
    const closingId = listedFile(closing);
    const stayingId = listedFile(staying);

    assert.equal(
      await provider.closeDocumentsInside([other], async () => {
        assert.fail("no close is refused with an action");
      }),
      true,
    );

    assert.deepEqual(
      { closing: naming(closingId, closing), staying: naming(stayingId, staying) },
      { closing: [undefined, undefined], staying: [staying, stayingId] },
    );
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider concurrent load specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A document can be requested by several consumers at once
 *                  (the pane that opens it, the agent API, the linter). Every
 *                  request for a file sees the one loaded document, with the
 *                  review that its sidecar reattaches.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { mkdirSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import { sha256Text } from "source/common/util/sha256";
import { bootDocumentManager } from "./documents-provider-seam";
import { userData } from "./headless-electron-harness.cjs";

const SOURCE = "alpha\nbeta\n";
const TARGET = "alpha\nBETA\n";

describe("Documents-provider concurrent load", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-concurrent-load-"));
    filePath = path.join(root, "Reviewed.md");
    writeFileSync(filePath, SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    provider = await bootDocumentManager(root);
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("gives every concurrent request the one document with its reattached review", async function () {
    const documentId = provider.ensureDocumentId(filePath);
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(SOURCE),
      [
        {
          description: "capitalize beta",
          patch: createPatch("document", SOURCE, TARGET, "", "", { context: 0 }),
        },
      ],
      "concurrent-load-proposal",
      0,
    );
    if (!submitted.ok) {
      assert.fail(`The review proposal was refused: ${submitted.code}`);
    }
    // Closing detaches the review to its sidecar; the next load reattaches it.
    await provider.closeFileEverywhere(filePath);
    assert.deepEqual(
      provider.loadedDocuments.map((document) => document.filePath),
      [],
    );

    const loads = await Promise.all([
      provider.getDocument(filePath),
      provider.getDocument(filePath),
    ]);

    assert.deepEqual(
      loads.map((load) => load.content),
      [TARGET, TARGET],
    );
    assert.equal(loads[0].startVersion, loads[1].startVersion);
    assert.deepEqual(
      provider.loadedDocuments.map((document) => document.filePath),
      [filePath],
    );
    assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 1);
  });
});

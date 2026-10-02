/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider closed-tab history specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real document manager through closing the
 *                  last tab and reopening closed tabs in reverse order.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type DocumentManager from "source/app/service-providers/documents";
import { bootDocumentManager } from "./documents-provider-seam";

describe("Documents-provider closed tabs", () => {
  let root: string;
  let provider: DocumentManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-reopen-tab-"));
    await writeFile(path.join(root, "first.md"), "First\n");
    await writeFile(path.join(root, "second.md"), "Second\n");
    provider = await bootDocumentManager(root);
  });

  afterEach(async () => {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("reopens closed tabs in reverse order, including the last tab in a pane", async () => {
    const windowId = provider.windowKeys()[0];
    const leafId = provider.leafIds(windowId)[0];
    const first = path.join(root, "first.md");
    const second = path.join(root, "second.md");

    assert.equal(await provider.openFile(windowId, leafId, first), true);
    assert.equal(await provider.openFile(windowId, leafId, second), true);
    assert.equal(await provider.closeFile(windowId, leafId, second), true);
    assert.equal(await provider.closeFile(windowId, leafId, first), true);

    assert.equal(await provider.reopenClosedTab(windowId), true);
    assert.equal(provider.getActiveFile(provider.leafIds(windowId)[0]), first);
    assert.equal(await provider.reopenClosedTab(windowId), true);
    assert.equal(provider.getActiveFile(provider.leafIds(windowId)[0]), second);
    assert.equal(await provider.reopenClosedTab(windowId), false);
  });
});

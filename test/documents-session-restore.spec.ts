/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider session restore tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A start of the application restores the tabs of the last
 *                  session. It closes the tab of a file that is gone. A file
 *                  that the filesystem cannot examine has given no answer, so
 *                  its tab stays.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type DocumentManager from "source/app/service-providers/documents";
import { bootDocumentManager } from "./documents-provider-seam";

async function openTabs(provider: DocumentManager): Promise<string[]> {
  const tabs: string[] = [];
  await provider.forEachLeaf(async (tabManager) => {
    tabs.push(...tabManager.openFiles.map((file) => file.path));
    return false;
  });
  return tabs;
}

describe("Documents-provider session restore", () => {
  let root: string;
  let provider: DocumentManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-session-restore-"));
  });

  afterEach(async () => {
    for (const windowId of provider.windowKeys()) {
      await provider.closeAllTabs(windowId);
    }
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("closes the tab of a removed file and keeps the tab of a file that cannot be examined", async () => {
    const kept = path.join(root, "kept.md");
    const removed = path.join(root, "removed.md");
    const looped = path.join(root, "looped.md");
    for (const file of [kept, removed, looped]) {
      await writeFile(file, `${path.basename(file)}\n`);
    }

    provider = await bootDocumentManager(root);
    const windowId = provider.windowKeys()[0];
    const leafId = provider.leafIds(windowId)[0];
    for (const file of [kept, removed, looped]) {
      assert.equal(await provider.openFile(windowId, leafId, file, true), true);
    }
    assert.deepEqual(await openTabs(provider), [kept, removed, looped]);
    await provider.shutdown();

    await rm(removed);
    // A symbolic link to itself: each access to it fails with ELOOP.
    await rm(looped);
    await symlink(looped, looped);

    provider = await bootDocumentManager(root);
    assert.deepEqual(await openTabs(provider), [kept, looped]);
    assert.deepEqual(provider.windowKeys(), [windowId]);
  });
});

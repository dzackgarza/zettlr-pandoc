/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL tests of the index of the workspaces
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The FSAL lists the paths of a workspace, then reads each
 *                  one. Files that are removed between the list and the read
 *                  are gone, not a failure: the index reads the other files,
 *                  and its task leaves the status bar. These tests run the
 *                  real FSAL and the real task provider over a directory on
 *                  disk (#210).
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type FSAL from "source/app/service-providers/fsal";
import type { LRT_JSON } from "source/app/service-providers/long-running-tasks/task";
import { TaskStatus } from "source/app/service-providers/long-running-tasks/task";
import { bootFsal } from "./fsal-seam";
import { invokeMain } from "./main-ipc";

// Enough files that the index is still reading when the spec removes them.
const FILE_COUNT = 200;

describe("FSAL: the index of the workspaces", function () {
  let root: string;
  let notes: string[];
  let fsal: FSAL;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-reindex-"));
    notes = Array.from({ length: FILE_COUNT }, (_, index) =>
      path.join(root, `lattice-${index}.md`),
    );
    for (const [index, note] of notes.entries()) {
      await writeFile(note, `# Lattice ${index}\n\nAn even lattice of rank ${index}.\n`);
    }
    fsal = await bootFsal(root);
  });

  after(async function () {
    await fsal.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  async function tasks(): Promise<LRT_JSON[]> {
    return await invokeMain("lrt-provider", { command: "get-tasks" });
  }

  it("reads the other files when files go away during the index, and ends its task", async function () {
    const indexed = fsal.reindexFiles();
    // The task says how many paths it reads once the list is complete.
    while (!(await tasks()).some((task) => task.info?.startsWith("Indexing ") === true)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const kept = notes[0];
    const removed = notes.slice(1);
    await Promise.all(removed.map((note) => unlink(note)));

    const outcome = await indexed.then(
      () => "indexed",
      (error: Error) => error,
    );
    assert.deepEqual(
      (await tasks()).filter((task) => task.status === TaskStatus.ongoing),
      [],
      "no index task runs after the index",
    );
    assert.equal(outcome, "indexed", "a removed file does not stop the index");
    const descriptor = await fsal.getDescriptorFor(kept);
    assert.equal(descriptor.type === "file" ? descriptor.firstHeading : null, "Lattice 0");
  });
});

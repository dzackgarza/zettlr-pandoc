/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL watcher event tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The FSAL turns the events of its file watcher into the
 *                  events that it publishes. These tests run the real FSAL
 *                  and its real watcher over a directory on disk.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type FSAL from "source/app/service-providers/fsal";
import type { FSALEventPayload } from "source/app/service-providers/fsal";
import { LogLevel, type LogMessage } from "source/app/service-providers/log";
import writeFileAtomic from "write-file-atomic";
import { bootFilteredFsal, bootFsal } from "./fsal-seam";
import { invokeMain } from "./main-ipc";

/** The log that a window reads from the log provider of the FSAL. */
async function readLog(): Promise<LogMessage[]> {
  return await invokeMain("log-provider", { command: "retrieve-log-chunk", nextIndex: 0 });
}

/** The path of an event, whichever shape the event has. */
function eventPath(payload: FSALEventPayload): string {
  return "path" in payload ? payload.path : payload.descriptor.path;
}

describe("FSAL watcher events", function () {
  let root: string;
  let document: string;
  let fsal: FSAL;
  const published: FSALEventPayload[] = [];

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-watcher-"));
    document = path.join(root, "note.md");
    await writeFile(document, "# Note\n");

    fsal = await bootFsal(root);
    fsal.on("fsal-events", (events) => published.push(...events));
  });

  after(async function () {
    await fsal.shutdown();
  });

  it("logs no error for a file that is gone when its event arrives", async function () {
    // write-file-atomic writes `note.md.<number>` beside the document and
    // renames it over the document. The watcher reports add and change for
    // that name after the rename took the file away.
    const temporaryName = /note\.md\.\d+$/;
    const sawTemporaryFile = (): boolean =>
      published.some(
        (payload) => payload.event === "unlink" && temporaryName.test(eventPath(payload)),
      );
    const sawDocumentChange = (): boolean =>
      published.some((payload) => payload.event === "change" && eventPath(payload) === document);

    // The watcher reports nothing before its first scan ends, so the write
    // repeats until the FSAL publishes its events.
    const deadline = Date.now() + 20_000;
    let writes = 0;
    while (!(sawTemporaryFile() && sawDocumentChange()) && Date.now() < deadline) {
      writes += 1;
      await writeFileAtomic(document, `# Note\n\nWrite ${writes}.\n`);
      await sleep(250);
    }
    assert.ok(sawTemporaryFile(), "the FSAL must publish the removal of the temporary file");
    assert.ok(sawDocumentChange(), "the FSAL must publish the change of the document");

    const errors = (await readLog()).filter((entry) => entry.level === LogLevel.error);
    assert.deepEqual(
      errors.map((entry) => entry.message),
      [],
    );
  });

  it("reports a write of a watched file as a change, and never as a removal", async function () {
    // The documents provider watches the file of each tab with a watchdog of
    // its own, and closes the tabs of a file that is reported as removed.
    const watchdog = fsal.getWatchdog();
    const reported: string[] = [];
    watchdog.on("change", (event, reportedPath) => {
      if (reportedPath === document) {
        reported.push(event);
      }
    });
    watchdog.watchPath(document);

    // The watcher reports nothing before its first scan ends, so the write
    // repeats until the watcher reports it.
    const deadline = Date.now() + 20_000;
    let writes = 0;
    while (!reported.includes("change") && Date.now() < deadline) {
      writes += 1;
      await fsal.writeTextFile(document, `# Note\n\nSave ${writes}.\n`);
      await sleep(250);
    }
    // Five more saves, and the time for their events to arrive.
    for (let save = 1; save <= 5; save++) {
      await fsal.writeTextFile(document, `# Note\n\nLate save ${save}.\n`);
      await sleep(100);
    }
    await sleep(500);
    await watchdog.shutdown();

    assert.ok(reported.includes("change"), "a write is reported as a change");
    assert.deepEqual(
      reported.filter((event) => event !== "change"),
      [],
      "no write is reported as another event",
    );
  });

  it("reports a rename over a watched file as a removal of the source only", async function () {
    // A rename of the file of one tab onto the file of another tab: the
    // documents provider moves the document to the target, and a removal
    // that the watcher reported for the target would close it there.
    const source = path.join(root, "source.md");
    const target = path.join(root, "target.md");
    await writeFile(source, "# Source\n");
    await writeFile(target, "# Target\n");
    const watchdog = fsal.getWatchdog();
    const reported: Array<[string, string]> = [];
    watchdog.on("change", (event, reportedPath) => {
      reported.push([event, reportedPath]);
    });
    watchdog.watchPath(source);
    watchdog.watchPath(target);

    // The watcher reports nothing before its first scan ends, so the write
    // repeats until the watcher reports it for each file.
    const sawChange = (filePath: string): boolean =>
      reported.some(([event, reportedPath]) => event === "change" && reportedPath === filePath);
    const deadline = Date.now() + 20_000;
    let writes = 0;
    while (!(sawChange(source) && sawChange(target)) && Date.now() < deadline) {
      writes += 1;
      await writeFile(source, `# Source\n\nWrite ${writes}.\n`);
      await writeFile(target, `# Target\n\nWrite ${writes}.\n`);
      await sleep(250);
    }
    assert.ok(sawChange(source) && sawChange(target), "the watcher follows both files");

    await rename(source, target);
    const removalDeadline = Date.now() + 10_000;
    const removals = (): string[] =>
      reported.filter(([event]) => event === "unlink").map(([, reportedPath]) => reportedPath);
    while (removals().length === 0 && Date.now() < removalDeadline) {
      await sleep(100);
    }
    // The time for a late event of the target.
    await sleep(1_000);
    await watchdog.shutdown();

    assert.deepEqual(removals(), [source], "the source is reported as removed, the target is not");
  });
});

describe("FSAL watcher events with the file filters on", function () {
  let chapter: string;
  let fsal: FSAL;
  const published: FSALEventPayload[] = [];

  before(async function () {
    const root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-watcher-filtered-"));
    chapter = path.join(root, "chapter");
    await mkdir(chapter);
    await writeFile(path.join(chapter, "draft.md"), "# Draft\n");

    fsal = await bootFilteredFsal(root);
    fsal.on("fsal-events", (events) => published.push(...events));
  });

  after(async function () {
    await fsal.shutdown();
  });

  it("publishes a change of a subfolder with the settings that were written", async function () {
    // The watcher reports a change of `.ztr-directory` as a change of its
    // folder. A window sorts the rows of a folder with the settings of the
    // descriptor that this event carries. The folder has no file type: the
    // file filters must judge it as a folder.
    const publishedSorting = (): string[] =>
      published.flatMap((payload) =>
        payload.event === "change" &&
        payload.descriptor.path === chapter &&
        payload.descriptor.type === "directory"
          ? [payload.descriptor.settings.sorting]
          : [],
      );

    // The watcher reports nothing before its first scan ends, so the write
    // repeats until the FSAL publishes the change of the folder.
    const deadline = Date.now() + 20_000;
    let writes = 0;
    while (!publishedSorting().includes("name-down") && Date.now() < deadline) {
      writes += 1;
      const sorting = writes % 2 === 0 ? "name-up" : "name-down";
      await fsal.setDirectorySetting(await fsal.getAnyDirectoryDescriptor(chapter), { sorting });
      await sleep(250);
    }
    assert.ok(
      publishedSorting().includes("name-down"),
      "the FSAL publishes the folder with the sort that was written",
    );
  });
});

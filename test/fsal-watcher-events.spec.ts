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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type FSAL from "source/app/service-providers/fsal";
import type { FSALEventPayload } from "source/app/service-providers/fsal";
import { LogLevel, type LogMessage } from "source/app/service-providers/log";
import writeFileAtomic from "write-file-atomic";
import { bootFsal } from "./fsal-seam";
import { ipcMainHandlers } from "./headless-electron-harness.cjs";

type LogChunkHandler = (
  event: null,
  payload: { command: "retrieve-log-chunk"; nextIndex: number },
) => LogMessage[];

/** The path of an event, whichever shape the event has. */
function eventPath(payload: FSALEventPayload): string {
  return "path" in payload ? payload.path : payload.descriptor.path;
}

describe("FSAL watcher events", function () {
  let root: string;
  let document: string;
  let fsal: FSAL;
  let readLog: () => LogMessage[];
  const published: FSALEventPayload[] = [];

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-watcher-"));
    document = path.join(root, "note.md");
    await writeFile(document, "# Note\n");

    fsal = await bootFsal(root);
    const handler = ipcMainHandlers.get("log-provider") as LogChunkHandler;
    readLog = () => handler(null, { command: "retrieve-log-chunk", nextIndex: 0 });
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

    const errors = readLog().filter((entry) => entry.level === LogLevel.error);
    assert.deepEqual(
      errors.map((entry) => entry.message),
      [],
    );
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider kept remote change specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A loaded file changes on disk while the user does not
 *                  reload changes automatically. The REAL DocumentManager
 *                  keeps the editor contents, asks nothing, and tells each
 *                  window once; the window's "Load from disk" replaces the
 *                  buffer with the disk version.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { BrowserWindow } from "electron";
import { mkdirSync, utimesSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type DocumentManager from "source/app/service-providers/documents";
import {
  REMOTE_CHANGE_KEPT_CHANNEL,
  type RemoteChangeKeptBroadcast,
} from "source/types/common/documents";
import { bootDocumentManager, emitWatchdogEvent } from "./documents-provider-seam";
import {
  ipcMainHandlers,
  messageBoxes,
  sentMessagesFor,
  userData,
} from "./headless-electron-harness.cjs";

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

const EDITOR_SOURCE = "The editor version.\n";
const DISK_SOURCE = "The disk version.\n";

describe("Documents-provider kept remote change", function () {
  let root: string;
  let filePath: string;
  let provider: DocumentManager;
  let window: BrowserWindow;

  /** Waits until the watchdog event has run through the provider. */
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 20; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function keptBroadcasts(): RemoteChangeKeptBroadcast[] {
    return sentMessagesFor(window)
      .filter(([channel]) => channel === REMOTE_CHANGE_KEPT_CHANNEL)
      .map(([, payload]) => payload as RemoteChangeKeptBroadcast);
  }

  /** Writes the disk version with a modification time after the loaded one. */
  function changeOnDisk(content: string, secondsAhead: number): void {
    writeFileSync(filePath, content, "utf-8");
    const later = new Date(Date.now() + secondsAhead * 1000);
    utimesSync(filePath, later, later);
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-remote-kept-"));
    filePath = path.join(root, "Chapter.md");
    writeFileSync(filePath, EDITOR_SOURCE, "utf-8");
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    await rm(path.join(userData, "documents.yaml"), { force: true });
    messageBoxes.shown.length = 0;
    messageBoxes.answer = undefined;
    provider = await bootDocumentManager(root);
    await provider.getDocument(filePath);
    window = new BrowserWindow();
  });

  afterEach(async function () {
    window.close();
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the editor contents, asks nothing, and tells the window once", async function () {
    changeOnDisk(DISK_SOURCE, 10);
    emitWatchdogEvent("change", filePath);
    emitWatchdogEvent("change", filePath);
    await settle();

    assert.deepEqual(messageBoxes.shown, []);
    assert.equal(provider.readMarkdownBufferContent(filePath), EDITOR_SOURCE);
    assert.equal(provider.isModified(filePath), true);
    assert.deepEqual(keptBroadcasts(), [{ filePath, unsavedChanges: false }]);

    changeOnDisk("A second disk version.\n", 20);
    emitWatchdogEvent("change", filePath);
    await settle();
    assert.equal(keptBroadcasts().length, 2, "a newer disk version is a new notice");
  });

  it("replaces the buffer with the disk version when the user loads it", async function () {
    changeOnDisk(DISK_SOURCE, 10);
    emitWatchdogEvent("change", filePath);
    await settle();

    const handler = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(handler !== undefined, "the documents-provider handler is registered");
    await handler(undefined, { command: "load-from-disk", payload: { path: filePath } });
    await provider.getDocument(filePath);

    assert.equal(provider.readMarkdownBufferContent(filePath), DISK_SOURCE);
    assert.equal(provider.isModified(filePath), false);
  });
});

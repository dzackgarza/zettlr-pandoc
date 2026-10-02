/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider remote change specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager's watchdog handler with
 *                  disk events for open tabs. Every open tab is watched, but
 *                  only a tab an editor has shown has a loaded document: a
 *                  change to an unshown tab is nothing to reconcile, while a
 *                  deletion still closes it.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { DP_EVENTS } from "@dts/common/documents";
import { strict as assert } from "assert";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import DocumentManager, {
  type DocumentsUpdateContext,
} from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import { ipcMainHandlers, userData } from "./headless-electron-harness.cjs";

const FIXTURE_ROOT = path.resolve("test", "fixtures", "reference-workspace");
const HALPHEN = path.join(FIXTURE_ROOT, "ProjectA", "Halphen_Surfaces.md");
const THEOREMS = path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md");

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;
type WatchdogListener = (event: string, filePath: string) => void;

describe("Documents-provider remote changes", function () {
  let provider: DocumentManager;
  let windowId: string;
  let leafId: string;
  let watchdogListener: WatchdogListener | undefined;
  const remoteChangeErrors: DocumentsUpdateContext[] = [];
  const closedFiles: DocumentsUpdateContext[] = [];

  async function invoke(command: string, payload?: unknown): Promise<unknown> {
    const registered = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(
      registered !== undefined,
      "constructing DocumentManager must register the documents-provider handler",
    );
    return await registered(undefined, { command, payload });
  }

  async function emitDiskEvent(event: "change" | "unlink", filePath: string): Promise<void> {
    assert.ok(watchdogListener !== undefined, "the manager must subscribe to the watchdog");
    watchdogListener(event, filePath);
    // The handler settles its promise chain before the next macrotask.
    await new Promise((resolve) => setImmediate(resolve));
  }

  before(async function () {
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    rmSync(path.join(userData, "documents.yaml"), { force: true });

    const watcherSeam = {
      on: (_name: string, listener: WatchdogListener) => {
        watchdogListener = listener;
      },
      getWatched: () => ({}),
      watchPath: (_path: string) => {},
      unwatchPath: (_path: string) => {},
      shutdown: async () => {},
    };
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: { openFiles: [], openWorkspaces: [FIXTURE_ROOT] },
          system: { avoidNewTabs: false },
        }),
        addPath: (_path: string) => false,
      },
      fsal: {
        getWatchdog: () => watcherSeam,
        testAccess: async () => true,
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {},
      },
      recentDocs: {
        add: (_path: string) => {},
        markEdited: (_path: string) => {},
      },
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {},
      },
    };

    provider = new DocumentManager(appSeam as unknown as AppServiceContainer);
    await provider.boot();
    windowId = provider.windowKeys()[0];
    leafId = provider.leafIds(windowId)[0];
    provider.on(DP_EVENTS.FILE_REMOTE_CHANGE_ERROR, (...args: unknown[]) => {
      remoteChangeErrors.push(args[0] as DocumentsUpdateContext);
    });
    provider.on(DP_EVENTS.CLOSE_FILE, (...args: unknown[]) => {
      closedFiles.push(args[0] as DocumentsUpdateContext);
    });

    assert.equal(
      await invoke("open-file", { windowId, leafId, path: HALPHEN, newTab: true }),
      true,
    );
    assert.equal(
      await invoke("open-file", { windowId, leafId, path: THEOREMS, newTab: true }),
      true,
    );
  });

  after(async function () {
    await provider.shutdown();
  });

  it("reports no failure when a tab no editor has shown changes on disk", async function () {
    await emitDiskEvent("change", HALPHEN);
    assert.deepEqual(remoteChangeErrors, []);
  });

  it("closes a tab no editor has shown when its file is deleted", async function () {
    await emitDiskEvent("unlink", HALPHEN);
    assert.deepEqual(
      closedFiles.map((context) => context.filePath),
      [HALPHEN],
    );
  });
});

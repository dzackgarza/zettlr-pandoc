/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider navigation join specs (issue #1, review C6)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the documents-provider half of the reference
 *                  navigation join at the provider layer (the TabManager
 *                  history semantics themselves stay locked by
 *                  test/tab-manager-history.spec.ts). Driven per the
 *                  provider-shell pattern: the REAL DocumentManager is
 *                  constructed over its injected AppServiceContainer seam,
 *                  booted against the real on-disk fixture workspace, and
 *                  invoked through the REAL registered 'documents-provider'
 *                  ipcMain handler. Proven joins:
 *
 *                  - 'open-file' carrying targetRange/sourceLocation STAMPS
 *                    the origin pane's current history entry with the sent
 *                    DocumentLocation and ECHOES targetRange on the
 *                    ACTIVE_FILE broadcast context (the renderer's cue to
 *                    select the definition token).
 *                  - 'navigate-back' returns the WIDENED history entry: the
 *                    ACTIVE_FILE broadcast carries the origin path plus the
 *                    exact stamped DocumentLocation, and the forward leg
 *                    restores the stamped destination location symmetrically.
 *
 * END HEADER
 */

// biome-ignore-all assist/source/organizeImports: the harness installs the
// electron stand-in at module scope, so it has to load before any module
// that imports electron itself. Sorting these imports breaks the specs.
import { ipcMainHandlers, userData } from "./headless-electron-harness.cjs";
import { DP_EVENTS } from "@dts/common/documents";
import type { DocumentLocation } from "@dts/common/references";
import { strict as assert } from "assert";
import { mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import DocumentManager, {
  type DocumentsUpdateContext,
} from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.

const FIXTURE_ROOT = path.resolve("test", "fixtures", "reference-workspace");
const HALPHEN = path.join(FIXTURE_ROOT, "ProjectA", "Halphen_Surfaces.md");
const THEOREMS = path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md");

/**
 * The harness's Electron userData directory. Read from the harness rather than
 * recomputed: it is created per process, and a second copy of the path here is
 * how the two came to share one fixed directory across concurrent runs.
 */
const USER_DATA: string = userData;

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

describe("Documents-provider navigation join (review C6)", function () {
  let provider: DocumentManager;
  let windowId: string;
  let leafId: string;
  /** Every ACTIVE_FILE broadcast context, in emission order. */
  const activeFileEvents: DocumentsUpdateContext[] = [];

  /** The real registered 'documents-provider' handler. */
  function handler(): IpcHandler {
    const registered = ipcMainHandlers.get("documents-provider") as IpcHandler | undefined;
    assert.ok(
      registered !== undefined,
      "constructing DocumentManager must register the documents-provider handler",
    );
    return registered;
  }

  async function invoke(command: string, payload?: unknown): Promise<unknown> {
    return await handler()(undefined, { command, payload });
  }

  before(async function () {
    // Isolate the provider's persisted tab-tree store: a fresh boot must
    // create one window with one empty pane.
    mkdirSync(USER_DATA, { recursive: true });
    mkdirSync(path.join(USER_DATA, "logs"), { recursive: true });
    rmSync(path.join(USER_DATA, "documents.yaml"), { force: true });

    // The injected AppServiceContainer seam, per the provider-shell pattern:
    // only the surfaces the exercised open/navigate paths consume, with the
    // real filesystem underneath (the fixture files are real files).
    const watcherSeam = {
      on: () => {},
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
      },
      // The manager drives the references provider's live overlay at its
      // mutation points (issue #53); this spec asserts navigation, not
      // reference state, so the seam only has to exist.
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {},
      },
    };

    provider = new DocumentManager(appSeam as unknown as AppServiceContainer);
    await provider.boot();

    const windows = provider.windowKeys();
    assert.equal(windows.length, 1, "a fresh boot must restore exactly one window");
    windowId = windows[0];
    const leafs = provider.leafIds(windowId);
    assert.equal(leafs.length, 1, "a fresh boot must restore exactly one pane");
    leafId = leafs[0];

    provider.on(DP_EVENTS.ACTIVE_FILE, (...args: unknown[]) => {
      activeFileEvents.push(args[0] as DocumentsUpdateContext);
    });
  });

  after(async function () {
    await provider.shutdown();
  });

  it("open-file with targetRange/sourceLocation stamps history and echoes the range", async function () {
    // Open the origin document plainly first: the pane's current history
    // entry now belongs to Halphen_Surfaces.md.
    const openedOrigin = await invoke("open-file", {
      windowId,
      leafId,
      path: HALPHEN,
      newTab: true,
    });
    assert.equal(openedOrigin, true, "the origin fixture document must open");

    // The reference jump, exactly as followReferenceNavigationIntent sends
    // it: the REAL authored range of the definition id token plus the
    // captured origin location.
    const theoremsSource = readFileSync(THEOREMS, "utf-8");
    const idStart = theoremsSource.indexOf("#thm:torelli");
    assert.ok(idStart > 0, "the fixture must define thm:torelli");
    const targetRange = { from: idStart, to: idStart + "#thm:torelli".length };
    const originLocation: DocumentLocation = {
      documentPath: HALPHEN,
      selection: { anchor: 42, head: 42 },
      scrollTop: 340,
      folds: [{ from: 3, to: 9 }],
      sourceGeneration: 0,
    };

    const opened = await invoke("open-file", {
      windowId,
      leafId,
      path: THEOREMS,
      newTab: true,
      targetRange,
      sourceLocation: originLocation,
    });
    assert.equal(opened, true, "the jump target document must open");

    // The join's outward half: the ACTIVE_FILE broadcast for the opened
    // target carries the echoed targetRange (the renderer selects it).
    const activation = activeFileEvents[activeFileEvents.length - 1];
    assert.equal(activation.filePath, THEOREMS, "the pane must activate the jump target");
    assert.deepEqual(
      activation.targetRange,
      targetRange,
      "the ACTIVE_FILE context must echo the definition targetRange",
    );

    const navState = (await invoke("get-navigation-state", { windowId, leafId })) as {
      canGoBack: boolean;
      canGoForward: boolean;
    };
    assert.deepEqual(
      navState,
      { canGoBack: true, canGoForward: false },
      "the jump must widen the pane history backwards",
    );
  });

  it("navigate-back returns the widened entry; forward restores the stamped destination", async function () {
    const originLocation: DocumentLocation = {
      documentPath: HALPHEN,
      selection: { anchor: 42, head: 42 },
      scrollTop: 340,
      folds: [{ from: 3, to: 9 }],
      sourceGeneration: 0,
    };
    // The renderer sends its CURRENT location with the request so the
    // provider can stamp the Theorems entry before moving (Forward must
    // restore it later).
    const theoremsLocation: DocumentLocation = {
      documentPath: THEOREMS,
      selection: { anchor: 7, head: 19 },
      scrollTop: 55,
      folds: [],
      sourceGeneration: 0,
    };

    await invoke("navigate-back", { windowId, leafId, location: theoremsLocation });

    const backEvent = activeFileEvents[activeFileEvents.length - 1];
    assert.equal(backEvent.filePath, HALPHEN, "Back must return to the jump origin document");
    assert.deepEqual(
      backEvent.location,
      originLocation,
      "Back must carry the EXACT DocumentLocation the open-file jump stamped onto the origin entry",
    );

    await invoke("navigate-forward", { windowId, leafId, location: originLocation });
    const forwardEvent = activeFileEvents[activeFileEvents.length - 1];
    assert.equal(
      forwardEvent.filePath,
      THEOREMS,
      "Forward must return to the jump target document",
    );
    assert.deepEqual(
      forwardEvent.location,
      theoremsLocation,
      "Forward must carry the DocumentLocation stamped by the Back request",
    );
  });
});

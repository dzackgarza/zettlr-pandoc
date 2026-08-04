/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent HTTP API cross-process E2E server fixture
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Standalone server used by agent-http-api-e2e-cross-process.spec.ts.
 *                  Bootstraps a real DocumentManager and AgentHTTPProvider, prints the
 *                  bound port on stdout, and keeps running until SIGTERM. This proves
 *                  the HTTP API can be reached from a separate OS process, which is the
 *                  same boundary a remote CLI or a Cloudflare tunnel client would use.
 *
 * END HEADER
 */

// Must load the headless electron harness before anything else so that
// main-process modules that import 'electron' resolve to the stub.
import "./headless-electron-harness.cjs";

import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import net from "net";
import os from "os";
import path from "path";
import { ChangeSet } from "@codemirror/state";
import serializeChangeSet from "@common/util/serialize-change-set";
import { BrowserWindow } from "electron";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import AgentHTTPProvider, {
  type AgentApiHost,
} from "source/app/service-providers/agent-api/http-server";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import type { SerializedUpdate } from "@dts/common/documents";

type DocumentManagerApp = ConstructorParameters<typeof DocumentManager>[0];

const scratch = mkdtempSync(path.join(os.tmpdir(), "zettlr-http-api-e2e-"));

function descriptorFor(filePath: string): CodeFileDescriptor {
  const stat = statSync(filePath);
  return {
    path: filePath,
    dir: path.dirname(filePath),
    name: path.basename(filePath),
    ext: path.extname(filePath),
    type: "code",
    size: stat.size,
    modtime: stat.mtimeMs,
    creationtime: stat.birthtimeMs,
    bom: "",
    linefeed: "\n",
  };
}

function normalizedRead(filePath: string): string {
  return readFileSync(filePath, "utf8")
    .split(/\r\n|\n\r|\n|\r/g)
    .join("\n");
}

function filesBelow(directoryPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesBelow(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function main(): Promise<void> {
  // Find a free port and listen on 127.0.0.1, the same binding the app uses.
  const freePortServer = net.createServer();
  const httpPort = await new Promise<number>((resolve, reject) => {
    freePortServer.listen(0, "127.0.0.1", () => {
      const address = freePortServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The E2E server did not bind a TCP address."));
        return;
      }
      freePortServer.close(() => resolve(address.port));
    });
  });

  const userData = path.join(scratch, "userData");
  mkdirSync(path.join(userData, "logs"), { recursive: true });
  const log = new LogProvider();

  const watcherSeam: ReturnType<DocumentManagerApp["fsal"]["getWatchdog"]> = {
    on: () => {},
    getWatched: () => ({}),
    watchPath: (_path: string) => {},
    unwatchPath: (_path: string) => {},
    shutdown: async () => {},
  };

  let activeWindowId = "";
  const mainWindow = new BrowserWindow();
  const appSeam: DocumentManagerApp & AgentApiHost = {
    log,
    config: {
      get: () => ({
        app: {
          openFiles: [],
          openWorkspaces: [scratch],
        },
        system: {
          avoidNewTabs: false,
        },
        editor: {
          autoSave: "off",
        },
        files: {
          images: { openWith: "zettlr" },
          pdf: { openWith: "zettlr" },
        },
        appLang: "en-US",
        alwaysReloadFiles: false,
        agentApi: {
          enabled: true,
          port: httpPort,
        },
      }),
      addPath: (_path: string) => false,
      set: (_key: string, _value: unknown) => {},
    },
    fsal: {
      getWatchdog: () => watcherSeam,
      testAccess: async () => true,
      getDescriptorForAnySupportedFile: async (filePath: string) =>
        descriptorFor(filePath),
      loadAnySupportedFile: async (filePath: string) =>
        normalizedRead(filePath),
      writeTextFile: async (filePath: string, content: string) => {
        writeFileSync(filePath, content, "utf8");
      },
      getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
      getFilesystemMetadata: async (filePath: string) => ({
        modtime: statSync(filePath).mtimeMs,
      }),
      readDirectoryRecursively: async (workspacePath: string) =>
        filesBelow(workspacePath),
    },
    citeproc: {
      synchronizeDatabases: async (_libraries: string[]) => {},
    },
    recentDocs: {
      add: (_path: string) => {},
    },
    stats: {
      updateCounts: (_words: number, _chars: number) => {},
    },
    windows: {
      askSaveChanges: async () => ({
        response: 2,
        checkboxChecked: false,
      }),
      getFirstMainWindow: () => mainWindow,
      getMainWindowKey: (window: BrowserWindow) =>
        window === mainWindow ? activeWindowId : undefined,
    },
    // The manager drives the references provider's live overlay at its
    // mutation points (issue #53); this harness exercises the agent API,
    // so the seam only has to exist.
    references: {
      reportAuthorityBuffer: (_filePath: string) => {},
      dropAuthorityBuffer: (_filePath: string) => {},
    },
  };

  const provider = new DocumentManager(appSeam);
  await provider.boot();
  activeWindowId = provider.windowKeys()[0];

  const httpProvider = new AgentHTTPProvider(log, provider, appSeam);
  await httpProvider.boot();

  // Create a sample document so the parent process has something to query.
  const samplePath = path.join(scratch, "sample.md");
  writeFileSync(
    samplePath,
    "# E2E API\n\nOriginal content.\n",
    "utf8",
  );
  await provider.getDocument(samplePath);

  if (process.send === undefined) {
    throw new Error("The E2E server requires an IPC parent.");
  }
  process.send({
    event: "e2e-server-ready",
    port: httpPort,
    docPath: samplePath,
    scratch,
  });

  async function shutdown(): Promise<void> {
    try {
      await httpProvider.shutdown();
      await provider.shutdown();
      rmSync(scratch, { recursive: true, force: true });
      process.exit(0);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "e2e-server-failure",
          phase: "shutdown",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("message", (msg: unknown) => {
    if (msg === "shutdown") {
      void shutdown();
      return;
    }
    if (
      typeof msg !== "object" ||
      msg === null ||
      Array.isArray(msg) ||
      (msg as Record<string, unknown>).event !== "set-sample-text" ||
      typeof (msg as Record<string, unknown>).requestId !== "string" ||
      typeof (msg as Record<string, unknown>).text !== "string"
    ) {
      return;
    }
    const request = msg as Record<string, string>;
    const document = provider.loadedDocuments.find((entry) => entry.filePath === samplePath);
    if (document === undefined) {
      process.send?.({
        event: "sample-text-result",
        requestId: request.requestId,
        ok: false,
        message: "sample document is not loaded",
      });
      return;
    }
    const changes = ChangeSet.of(
      [{ from: 0, to: document.document.length, insert: request.text }],
      document.document.length,
    );
    const update: SerializedUpdate = {
      clientID: "review-diff-cli-e2e",
      changes: serializeChangeSet(changes),
    };
    const pushUpdates = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(provider),
      "pushUpdates",
    )?.value as
      | ((filePath: string, version: number, updates: SerializedUpdate[]) => Promise<boolean>)
      | undefined;
    if (pushUpdates === undefined) {
      process.send?.({
        event: "sample-text-result",
        requestId: request.requestId,
        ok: false,
        message: "the authority update seam is unavailable",
      });
      return;
    }
    void pushUpdates.call(provider, samplePath, document.currentVersion, [update]).then(
      (ok) => {
        process.send?.({
          event: "sample-text-result",
          requestId: request.requestId,
          ok,
        });
      },
      (error: unknown) => {
        process.send?.({
          event: "sample-text-result",
          requestId: request.requestId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

main().catch((err) => {
  console.error("E2E server failed:", err);
  process.exit(1);
});

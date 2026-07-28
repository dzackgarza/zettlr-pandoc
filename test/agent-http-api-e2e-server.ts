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

import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import AgentHTTPProvider from "source/app/service-providers/agent-api/http-server";
import type { AppServiceContainer } from "source/app/app-service-container";
import type { CodeFileDescriptor } from "@dts/common/fsal";

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

import { readFileSync } from "fs";

async function main(): Promise<void> {
  // Find a free port and listen on 127.0.0.1, the same binding the app uses.
  const freePortServer = net.createServer();
  const httpPort = await new Promise<number>((resolve) => {
    freePortServer.listen(0, "127.0.0.1", () => {
      const addr = freePortServer.address() as net.AddressInfo;
      freePortServer.close(() => resolve(addr.port));
    });
  });

  const userData = path.join(scratch, "userData");
  mkdirSync(path.join(userData, "logs"), { recursive: true });

  const watcherSeam = {
    on: () => {},
    getWatched: () => ({}),
    watchPath: (_path: string) => {},
    unwatchPath: (_path: string) => {},
    shutdown: async () => {},
  };

  let activeWindowId = "";
  const appSeam = {
    log: new LogProvider(),
    config: {
      get: () => ({
        app: {
          openFiles: [],
          openWorkspaces: [scratch],
          appLang: "en-US",
        },
        system: {
          avoidNewTabs: false,
        },
        editor: {
          autoSave: "off",
        },
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
    },
    citeproc: {
      synchronizeDatabases: async (_libraries: string[]) => {},
    },
    recentDocs: {
      add: (_path: string) => {},
    },
    windows: {
      showAnyWindow: () => {},
      getFirstMainWindow: () => ({}),
      getMainWindowKey: (_window: unknown) => activeWindowId,
    },
  };

  const provider = new DocumentManager(
    appSeam as unknown as AppServiceContainer,
  );
  await provider.boot();
  activeWindowId = provider.windowKeys()[0];

  const httpProvider = new AgentHTTPProvider(new LogProvider(), provider, {
    config: {
      get: () => ({
        agentApi: {
          enabled: true,
          port: httpPort,
        },
      }),
    },
  } as unknown as AppServiceContainer);
  await httpProvider.boot();

  // Create a sample document so the parent process has something to query.
  const samplePath = path.join(scratch, "sample.md");
  writeFileSync(
    samplePath,
    "# E2E certification\n\nOriginal content.\n",
    "utf8",
  );
  await provider.getDocument(samplePath);

  // Signal readiness. The parent parses this exact line.
  // eslint-disable-next-line no-console
  console.log(
    `E2E_SERVER_READY port=${httpPort} docPath=${samplePath} scratch=${scratch}`,
  );

  function shutdown(): void {
    httpProvider
      .shutdown()
      .then(() => provider.shutdown())
      .then(() => rmSync(scratch, { recursive: true, force: true }))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("message", (msg: unknown) => {
    if (msg === "shutdown") shutdown();
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("E2E server failed:", err);
  process.exit(1);
});

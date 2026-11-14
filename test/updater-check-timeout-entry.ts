/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Update check against a server that does not answer
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The program of `updater-check-timeout.spec.ts`. It runs
 *                  under the Node of Electron, as the main process of the
 *                  app does: the update check of the provider asks an HTTPS
 *                  address whose server accepts the connection and sends
 *                  nothing. It prints the state of the provider after the
 *                  check, and each rejection and exception that no code
 *                  handled.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { copyFile, mkdir } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import ConfigProvider from "source/app/service-providers/config";
import LogProvider from "source/app/service-providers/log";
import UpdateProvider from "source/app/service-providers/updates";
import { home } from "./headless-electron-harness.cjs";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

/** What the program prints, as JSON, on its last line. */
export interface CheckTimeoutReport {
  lastErrorCode: string | undefined;
  lastErrorMessage: string | undefined;
  /** The messages of the rejections that no code handled. */
  unhandledRejections: string[];
  /** The messages of the exceptions that no code caught. */
  uncaughtExceptions: string[];
}

const unhandledRejections: string[] = [];
const uncaughtExceptions: string[] = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
});
process.on("uncaughtException", (error) => {
  uncaughtExceptions.push(error.message);
});

async function main(): Promise<void> {
  // The server accepts a connection and never starts the TLS handshake.
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const log = new LogProvider();
  const config = new ConfigProvider(
    log,
    [path.resolve("static", "lang")],
    unexpectedStoreWriteFailure,
  );
  config.set("system.checkForUpdates", false);
  // The boot loads the MathJax projection of ~/.pandoc.
  const projection = path.join(home, ".pandoc", "templates", "css");
  await mkdir(projection, { recursive: true });
  await copyFile(
    path.resolve("test", "fixtures", "mathjax-macros.json"),
    path.join(projection, "mathjax-macros.json"),
  );
  const provider = new UpdateProvider(
    log,
    config,
    { showUpdateWindow: () => undefined },
    {
      releasePage: `${origin}/owner/app/releases`,
      releasesApi: `${origin}/repos/owner/app/releases`,
    },
  );
  await provider.boot();
  await provider.check();
  const { lastErrorCode, lastErrorMessage } = provider.getUpdateState();
  // A request that the HTTP client starts after the check ended starts
  // within 1.5 s and has the time limit of the check (5 s).
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  const report: CheckTimeoutReport = {
    lastErrorCode,
    lastErrorMessage,
    unhandledRejections,
    uncaughtExceptions,
  };
  process.stdout.write(`\n${JSON.stringify(report)}\n`);
  process.exit(0);
}

void main();

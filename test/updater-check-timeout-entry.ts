import "./headless-electron-harness.cjs";
import { copyFile, mkdir } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import ConfigProvider from "source/app/service-providers/config";
import LogProvider from "source/app/service-providers/log";
import UpdateProvider from "source/app/service-providers/updates";
import { home } from "./headless-electron-harness.cjs";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

export interface CheckTimeoutReport {
  lastErrorCode: string | undefined;
  lastErrorMessage: string | undefined;
  unhandledRejections: string[];
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
  const projection = path.join(home, ".pandoc", "templates", "css");
  await mkdir(projection, { recursive: true });
  for (const name of ["mathjax-macros.json"]) {
    await copyFile(path.resolve("test", "fixtures", name), path.join(projection, name));
  }
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

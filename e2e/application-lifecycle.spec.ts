import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import {
  createFixture,
  currentPackagedBinary,
  delay,
  findEditorPage,
  readAppLog,
  stopProcess,
  waitForDevTools,
} from "./support/electron-app";

describe("application launch delivery", function () {
  this.timeout(120_000);
  let binary: string;

  before(function () {
    binary = currentPackagedBinary();
  });

  it("waits for the owner to open the requested document before reporting success", async function () {
    const fixture = await createFixture("zettlr-lifecycle-", {
      documentName: "initial.md",
      documentContents: "# Initial document\n",
    });
    const requestedFile = path.join(fixture.root, "requested.md");
    const contents = "# A launch request must reach the editor\n";
    await writeFile(requestedFile, contents);
    const children: ChildProcess[] = [];
    let browser: Browser | undefined;
    let primaryOutput = "";
    let secondaryOutput = "";
    const launch = (files: string[]): ChildProcess => {
      const child = spawn(
        binary,
        [
          `--data-dir=${fixture.configDirectory}`,
          "--remote-debugging-port=0",
          "--disable-hardware-acceleration",
          "--ozone-platform=x11",
          ...files,
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      return child;
    };
    const primary = launch([]);
    primary.stdout!.on("data", (chunk) => {
      primaryOutput += chunk.toString();
    });
    primary.stderr!.on("data", (chunk) => {
      primaryOutput += chunk.toString();
    });
    try {
      // Suspend the actual owner once it holds Electron's lock. This controls
      // scheduling, not application behavior: the caller cannot yet be served.
      const deadline = Date.now() + 20_000;
      while (!existsSync(path.join(fixture.configDirectory, "SingletonSocket"))) {
        assert.deepEqual(
          { exitCode: primary.exitCode, signalCode: primary.signalCode },
          { exitCode: null, signalCode: null },
          `The owner ended before it held the lock:\n${primaryOutput}`,
        );
        assert.ok(Date.now() < deadline, primaryOutput);
        await delay(10);
      }
      assert.ok(primary.pid);
      process.kill(primary.pid, "SIGSTOP");
      const secondary = launch([requestedFile]);
      secondary.stdout!.on("data", (chunk) => {
        secondaryOutput += chunk.toString();
      });
      secondary.stderr!.on("data", (chunk) => {
        secondaryOutput += chunk.toString();
      });
      await delay(1500);
      assert.equal(
        secondary.exitCode,
        null,
        `Launch reported success before the owner could serve it: ${secondaryOutput}`,
      );
      const endpointReady = waitForDevTools(primary, () => primaryOutput, 60_000);
      process.kill(primary.pid, "SIGCONT");
      const endpoint = await endpointReady;
      browser = await chromium.connectOverCDP(endpoint);
      const page = await findEditorPage(browser, 60_000);
      await page
        .getByText("A launch request must reach the editor", { exact: false })
        .first()
        .waitFor({ timeout: 30_000 });
      const completed = Date.now() + 30_000;
      while (secondary.exitCode === null) {
        assert.ok(Date.now() < completed, secondaryOutput);
        await delay(50);
      }
      assert.equal(secondary.exitCode, 0, secondaryOutput);
      assert.match(secondaryOutput, /\[Application\] Launch complete\./);
      const rejected = launch([
        "--open-in-running-instance",
        path.join(fixture.root, "missing.md"),
      ]);
      const rejectedStatus = await new Promise<number | null>((resolve, reject) => {
        rejected.once("error", reject);
        rejected.once("exit", resolve);
      });
      assert.equal(rejectedStatus, 1, "A failed document open must fail the invoking process");
    } finally {
      if (primary.pid !== undefined && primary.exitCode === null && primary.signalCode === null)
        process.kill(primary.pid, "SIGCONT");
      await browser?.close();
      for (const child of children.reverse()) await stopProcess(child);
    }
  });

  it("hands a launch during shutdown to the next owner after one cleanup", async function () {
    const fixture = await createFixture("zettlr-shutdown-", {
      documentName: "initial.md",
      documentContents: "# Initial document\n",
    });
    const requestedFile = path.join(fixture.root, "after-shutdown.md");
    await writeFile(requestedFile, "# Document requested during shutdown\n");
    const primary = spawn(
      binary,
      [
        `--data-dir=${fixture.configDirectory}`,
        "--remote-debugging-port=0",
        "--disable-hardware-acceleration",
        "--ozone-platform=x11",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let primaryOutput = "";
    primary.stdout!.on("data", (chunk) => {
      primaryOutput += chunk.toString();
    });
    primary.stderr!.on("data", (chunk) => {
      primaryOutput += chunk.toString();
    });
    let secondary: ChildProcess | undefined;
    let browser: Browser | undefined;
    let output = "";
    const pid = primary.pid!;
    try {
      const primaryEndpoint = await waitForDevTools(primary, () => primaryOutput, 60_000);
      browser = await chromium.connectOverCDP(primaryEndpoint);
      const initial = await findEditorPage(browser, 60_000);
      await initial.locator(".cm-content").waitFor({ timeout: 60_000 });
      const logDirectory = path.join(fixture.configDirectory, "logs");
      const logName = (await readdir(logDirectory)).find((name) => name.endsWith(".log"));
      assert.ok(logName);
      const logPath = path.join(logDirectory, logName);
      const stopping = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          watcher.close();
          reject(new Error("The owner did not start shutdown"));
        }, 10_000);
        const watcher = watch(logPath, () => {
          if (!readFileSync(logPath, "utf8").includes("Shutting down at")) return;
          clearTimeout(timer);
          watcher.close();
          try {
            process.kill(pid, "SIGSTOP");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      await initial.evaluate(() => {
        window.ipc.send("menu-provider", {
          command: "click-menu-item",
          payload: "menu-quit",
        });
      });
      await stopping;
      secondary = spawn(
        binary,
        [
          `--data-dir=${fixture.configDirectory}`,
          "--remote-debugging-port=0",
          "--disable-hardware-acceleration",
          "--ozone-platform=x11",
          requestedFile,
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      secondary.stdout!.on("data", (chunk) => {
        output += chunk.toString();
      });
      secondary.stderr!.on("data", (chunk) => {
        output += chunk.toString();
      });
      await delay(1500);
      assert.equal(secondary.exitCode, null, output);
      const endpointReady = waitForDevTools(secondary, () => output, 60_000);
      process.kill(pid, "SIGCONT");
      browser = await chromium.connectOverCDP(await endpointReady);
      const page = await findEditorPage(browser, 60_000);
      await page
        .getByText("Document requested during shutdown", { exact: false })
        .first()
        .waitFor({ timeout: 30_000 });
      assert.equal(primary.exitCode, 0);
      assert.equal(secondary.exitCode, null, "The new owner must remain running");
      const log = await readAppLog(fixture.root);
      assert.equal(
        log.split("Application uptime was:").length - 1,
        1,
        "Repeated quit requests must run cleanup once",
      );
    } finally {
      if (primary.exitCode === null && primary.signalCode === null) process.kill(pid, "SIGCONT");
      await browser?.close();
      await stopProcess(primary);
      await stopProcess(secondary);
    }
  });
});

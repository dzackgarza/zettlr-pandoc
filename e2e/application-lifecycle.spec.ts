import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { createFixture, delay, findEditorPage, stopProcess, waitForDevTools } from "./support/electron-app";

const binary = path.resolve("out/Zettlr-Pandoc-linux-x64/zettlr-pandoc");

describe("application launch delivery", function () {
  this.timeout(120_000);

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
      const child = spawn(binary, [
        `--data-dir=${fixture.configDirectory}`, "--remote-debugging-port=0",
        "--disable-hardware-acceleration", "--ozone-platform=x11", ...files,
      ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      return child;
    };
    const primary = launch([]);
    primary.stdout!.on("data", (chunk) => { primaryOutput += chunk.toString(); });
    primary.stderr!.on("data", (chunk) => { primaryOutput += chunk.toString(); });
    try {
      // Suspend the actual owner once it holds Electron's lock. This controls
      // scheduling, not application behavior: the caller cannot yet be served.
      const deadline = Date.now() + 20_000;
      while (!existsSync(path.join(fixture.configDirectory, "SingletonSocket"))) {
        assert.equal(primary.exitCode, null, primaryOutput);
        assert.ok(Date.now() < deadline, primaryOutput);
        await delay(10);
      }
      assert.ok(primary.pid);
      process.kill(primary.pid, "SIGSTOP");
      const secondary = launch([requestedFile]);
      secondary.stdout!.on("data", (chunk) => { secondaryOutput += chunk.toString(); });
      secondary.stderr!.on("data", (chunk) => { secondaryOutput += chunk.toString(); });
      await delay(1500);
      assert.equal(secondary.exitCode, null, `Launch reported success before the owner could serve it: ${secondaryOutput}`);
      const endpointReady = waitForDevTools(primary, () => primaryOutput, 60_000);
      process.kill(primary.pid, "SIGCONT");
      const endpoint = await endpointReady;
      browser = await chromium.connectOverCDP(endpoint);
      const page = await findEditorPage(browser, 60_000);
      await page.getByText("A launch request must reach the editor", { exact: false }).first().waitFor({ timeout: 30_000 });
      const completed = Date.now() + 30_000;
      while (secondary.exitCode === null) {
        assert.ok(Date.now() < completed, secondaryOutput);
        await delay(50);
      }
      assert.equal(secondary.exitCode, 0, secondaryOutput);
      assert.match(secondaryOutput, /\[Application\] Launch complete\./);
    } finally {
      if (primary.pid !== undefined && primary.exitCode === null) process.kill(primary.pid, "SIGCONT");
      await browser?.close();
      for (const child of children.reverse()) await stopProcess(child);
    }
  });
});

/**
 * Assembled-app proof that the first-start onboarding sets how images and
 * PDFs open and leaves what the file manager lists to the File filters
 * window, the one editor of the file type filters.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConfigOptions } from "@providers/config/get-config-template";
import { type Browser, chromium, type Page } from "playwright";
import {
  assertCleanExit,
  delay,
  launchElectron,
  observeRenderer,
  preserveArtifacts,
  shutdown,
  waitForApplicationBoot,
  waitForDevTools,
} from "./support/electron-app";

type FileTypeSetting = ConfigOptions["files"]["images"];

describe("assembled app: first-start onboarding and the file type filters", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let output = "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  async function onboardingPage(timeoutMs: number): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("/onboarding/"));
      if (page !== undefined) {
        return page;
      }
      await delay(100);
    }
    throw new Error("The onboarding window did not open");
  }

  function readFileTypes(page: Page): Promise<{ images: FileTypeSetting; pdf: FileTypeSetting }> {
    return page.evaluate(() => {
      const config = window.ipc.sendSync<ConfigOptions>("config-provider", {
        command: "get-config",
      });
      return { images: config.files.images, pdf: config.files.pdf };
    });
  }

  before(async function () {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "zettlr-onboarding-e2e-"));
    const configDirectory = path.join(fixtureRoot, "config");
    const documentsDirectory = path.join(fixtureRoot, "documents");
    const xdgConfigHome = path.join(fixtureRoot, "xdg-config");
    await mkdir(configDirectory);
    await mkdir(documentsDirectory);
    await mkdir(xdgConfigHome);
    // A first start copies the tutorial into the documents directory; this
    // keeps it inside the fixture.
    await writeFile(
      path.join(xdgConfigHome, "user-dirs.dirs"),
      `XDG_DOCUMENTS_DIR="${documentsDirectory}"\n`,
      "utf8",
    );

    // No config.json in the data directory: the app starts for the first time.
    appProcess = await launchElectron(configDirectory, {
      environment: { XDG_CONFIG_HOME: xdgConfigHome },
    });
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-200_000);
    };
    appProcess.stdout?.on("data", appendOutput);
    appProcess.stderr?.on("data", appendOutput);
    const devToolsUrl = await waitForDevTools(appProcess, () => output, this.timeout());
    browser = await chromium.connectOverCDP(devToolsUrl);
    for (const context of browser.contexts()) {
      context.pages().forEach((page) => observeRenderer(page, rendererEvents));
      context.on("page", (page) => observeRenderer(page, rendererEvents));
    }
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-onboarding-e2e-latest"),
      fixtureRoot,
      output,
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assertCleanExit(output);
  });

  it("switches how images and PDFs open and keeps them listed", async function () {
    const page = await onboardingPage(this.timeout());
    await page.locator("#onboarding-progress span").first().waitFor({ state: "visible" });
    const before = await readFileTypes(page);
    assert.deepEqual(before, {
      images: { showInFilemanager: true, openWith: "system" },
      pdf: { showInFilemanager: true, openWith: "system" },
    });

    // The eighth dot of the progress bar is the Images and PDFs page.
    await page.locator("#onboarding-progress span").nth(7).click();
    const toggle = page.locator('button:has-text("Preview images and PDFs in Zettlr")');
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("onboarding-other-files.png", await page.screenshot());

    // The page writes through a synchronous IPC call in the click handler.
    await toggle.click();
    assert.deepEqual(await readFileTypes(page), {
      images: { showInFilemanager: true, openWith: "zettlr" },
      pdf: { showInFilemanager: true, openWith: "zettlr" },
    });

    await toggle.click();
    assert.deepEqual(await readFileTypes(page), before);
    screenshots.set("onboarding-other-files-off.png", await page.screenshot());

    await page.locator('nav button:has-text("Skip")').click();
    assert.ok(appProcess !== undefined, "the app process runs");
    await waitForApplicationBoot(appProcess, () => output, this.timeout());
  });
});

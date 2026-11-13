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
  clickToClose,
  delay,
  findEditorPage,
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
  let tutorialDirectory = "";
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
    tutorialDirectory = path.join(documentsDirectory, "Zettlr Tutorial");
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

  it("keeps the image and the PDF of the tutorial listed after a click on the preview toggle", async function () {
    const page = await onboardingPage(this.timeout());
    await page.locator("#onboarding-progress span").first().waitFor({ state: "visible" });
    assert.deepEqual(await readFileTypes(page), {
      images: { showInFilemanager: true, openWith: "system" },
      pdf: { showInFilemanager: true, openWith: "system" },
    });

    // The eighth dot of the progress bar is the Images and PDFs page.
    await page.locator("#onboarding-progress span").nth(7).click();
    const toggle = page.locator('button:has-text("Preview images and PDFs in Zettlr")');
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
    // The page slides in; the welcome page stays mounted until it has left.
    await page.waitForFunction(() => document.querySelectorAll(".page").length === 1);
    screenshots.set("onboarding-other-files.png", await page.screenshot());
    await toggle.click();
    screenshots.set("onboarding-other-files-clicked.png", await page.screenshot());

    await clickToClose(page, page.locator('nav button:has-text("Skip")'));
    assert.ok(appProcess !== undefined, "the app process runs");
    await waitForApplicationBoot(appProcess, () => output, this.timeout());

    // The first start opens the tutorial, which has an image and a PDF, as a
    // workspace. The default file types are the Markdown types; with PNG and
    // PDF included, as the File filters window includes them, the file
    // manager lists both, whatever the author chose for the previews.
    assert.ok(browser !== undefined, "the browser is connected");
    const main = await findEditorPage(browser, this.timeout());
    await main.evaluate(() => {
      const config = window.ipc.sendSync<ConfigOptions>("config-provider", {
        command: "get-config",
      });
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: {
          key: "fileManager.filters.include",
          val: [...config.fileManager.filters.include, ".png", ".pdf"],
        },
      });
    });
    const row = (name: string) =>
      main.locator(
        `#file-manager .tree-item[data-path=${JSON.stringify(path.join(tutorialDirectory, name))}]`,
      );
    await row("welcome.md").waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("file-manager-after-onboarding.png", await main.screenshot());
    for (const name of ["zettlr.png", "LaTeX Guide.pdf"]) {
      await row(name).waitFor({ state: "visible", timeout: 15_000 });
    }
    screenshots.set("file-manager-lists-image-and-pdf.png", await main.screenshot());

    // The click decided only where images and PDFs open.
    assert.deepEqual(await readFileTypes(main), {
      images: { showInFilemanager: true, openWith: "zettlr" },
      pdf: { showInFilemanager: true, openWith: "zettlr" },
    });
  });
});

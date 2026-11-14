/**
 * Assembled-app proof that the first-start onboarding sets how images and
 * PDFs open and leaves what the file manager lists to the File filters
 * window, the one editor of the file type filters.
 */

import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConfigOptions } from "@providers/config/get-config-template";
import type { Page } from "playwright";
import {
  assertCleanExit,
  clickToClose,
  findEditorPage,
  preserveArtifacts,
  shutdown,
  waitForApplicationBoot,
} from "./support/electron-app";
import {
  type FirstStart,
  onboardingPage,
  showOnboardingPage,
  startFirstRun,
} from "./support/first-start";

type FileTypeSetting = ConfigOptions["files"]["images"];

describe("assembled app: first-start onboarding and the file type filters", function () {
  let start: FirstStart | undefined;
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  function readFileTypes(page: Page): Promise<{ images: FileTypeSetting; pdf: FileTypeSetting }> {
    return page.evaluate(() => {
      const config = window.ipc.sendSync<ConfigOptions>("config-provider", {
        command: "get-config",
      });
      return { images: config.files.images, pdf: config.files.pdf };
    });
  }

  before(async function () {
    start = await startFirstRun("zettlr-onboarding-e2e-", rendererEvents);
  });

  after(async function () {
    // A start that failed in the before hook left no app and no output.
    if (start === undefined) {
      return;
    }
    await shutdown(start.browser, start.appProcess);
    const output = start.getOutput();
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-onboarding-e2e-latest"),
      start.fixtureRoot,
      output,
      rendererEvents,
      screenshots,
    );
    await rm(start.fixtureRoot, { recursive: true, force: true });
    assertCleanExit(output);
  });

  it("keeps the image and the PDF of the tutorial listed after a click on the preview toggle", async function () {
    assert.ok(start !== undefined, "the first start ran");
    const { appProcess, browser, tutorialDirectory } = start;
    const page = await onboardingPage(browser, this.timeout());
    assert.deepEqual(await readFileTypes(page), {
      images: { showInFilemanager: true, openWith: "system" },
      pdf: { showInFilemanager: true, openWith: "system" },
    });

    // The eighth dot of the progress bar is the Images and PDFs page.
    await showOnboardingPage(page, 7, "Images and PDFs");
    const toggle = page.locator('button:has-text("Preview images and PDFs in Zettlr")');
    screenshots.set("onboarding-other-files.png", await page.screenshot());
    await toggle.click();
    screenshots.set("onboarding-other-files-clicked.png", await page.screenshot());

    await clickToClose(page, page.locator('nav button:has-text("Skip")'));
    await waitForApplicationBoot(appProcess, start.getOutput, this.timeout());

    // The first start opens the tutorial, which has an image and a PDF, as a
    // workspace. The default file types are the Markdown types; with PNG and
    // PDF included, as the File filters window includes them, the file
    // manager lists both, whatever the author chose for the previews.
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

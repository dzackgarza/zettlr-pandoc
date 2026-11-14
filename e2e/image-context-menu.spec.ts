/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Context menu of an image E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The editor shows the image of an image link. The author
 *                  opens the context menu of the image and chooses "Copy image
 *                  to clipboard": the clipboard then holds that image (#210).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-image-context-menu-e2e-latest");
const DOCUMENT = "# Orbits\n\nThe orbit of a point.\n\n![orbit](./orbit.png)\n";

/** An image of 32 by 32 pixels: the application icon of that size. */
const IMAGE_SOURCE = path.resolve(__dirname, "../resources/icons/png/32x32.png");

/** The size of the image that the clipboard holds, or null for no image. */
function clipboardImageSize(page: Page): Promise<{ width: number; height: number } | null> {
  return page.evaluate(async () => {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("image/png")) {
        const bitmap = await createImageBitmap(await item.getType("image/png"));
        return { width: bitmap.width, height: bitmap.height };
      }
    }
    return null;
  });
}

describe("assembled app: the context menu of an image", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-image-context-menu-e2e-", {
      documentName: "orbits.md",
      documentContents: DOCUMENT,
    });
    fixtureRoot = fixture.root;
    await copyFile(IMAGE_SOURCE, path.join(path.dirname(fixture.documentPath), "orbit.png"));
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  it("copies the image to the clipboard", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const figure = shown.locator("figure.image-preview");
    await figure.waitFor({ state: "visible", timeout: 20_000 });
    // The clipboard holds text before the copy.
    await shown.evaluate(() => navigator.clipboard.writeText("The orbit of a point."));

    await figure.click({ button: "right" });
    await shown
      .locator(".application-menu .menu-item")
      .filter({ has: shown.locator(".label", { hasText: /^Copy image to clipboard$/ }) })
      .click();

    const deadline = Date.now() + 10_000;
    let size = await clipboardImageSize(shown);
    while (Date.now() < deadline && size === null) {
      await delay(100);
      size = await clipboardImageSize(shown);
    }
    screenshots.set("copied-image.png", await shown.screenshot());
    assert.deepEqual(size, { width: 32, height: 32 }, "the clipboard holds the image");
  });
});

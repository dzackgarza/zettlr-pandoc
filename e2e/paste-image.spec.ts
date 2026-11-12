/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Paste of an image from the clipboard E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author copies an image to the clipboard and chooses
 *                  "Paste" in the context menu of the editor. The paste image
 *                  window opens; the author names the image and saves it. The
 *                  image is a file beside the document, and the document has
 *                  an image link to it (#210).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-paste-image-e2e-latest");
const DOCUMENT = "# Orbits\n\nThe orbit of a point.\n";
const IMAGE_NAME = "orbit-diagram";

/** The PNG header: each PNG file starts with these eight bytes. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The page of the paste image window, once it shows the image. */
async function findPasteImagePage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator("#paste-image img.image-preview[src^='data:']").count()) > 0) {
          return page;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No paste image window appeared within ${timeoutMs}ms`);
}

/** The text of a file once it holds the expected text, or its text ten seconds later. */
async function textThat(file: string, expected: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await readFile(file, "utf8");
  while (Date.now() < deadline && !expected(text)) {
    await delay(100);
    text = await readFile(file, "utf8");
  }
  return text;
}

describe("assembled app: paste of an image from the clipboard", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-paste-image-e2e-", {
      documentName: "orbits.md",
      documentContents: DOCUMENT,
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
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

  it("saves the image beside the document and links it", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    await shown.locator(".cm-content").click();
    await shown.keyboard.press("Control+End");
    // The clipboard holds an image of 40 by 30 pixels, as a screenshot does.
    await shown.evaluate(async () => {
      const canvas = new OffscreenCanvas(40, 30);
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("The canvas has no 2d context");
      }
      context.fillStyle = "#3366aa";
      context.fillRect(0, 0, 40, 30);
      const png = await canvas.convertToBlob({ type: "image/png" });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    });

    await shown.locator(".cm-content").click({ button: "right" });
    await shown
      .locator(".application-menu .menu-item")
      .filter({ has: shown.locator(".label", { hasText: /^Paste$/ }) })
      .click();

    const modal = await findPasteImagePage(requireInitialized(browser, "No browser"), 20_000);
    screenshots.set("paste-image-window.png", await modal.screenshot());
    await modal.locator("#paste-image input[type='text']").first().fill(IMAGE_NAME);
    await modal.locator("#statusbar button", { hasText: "Save" }).click();

    const imagePath = path.join(path.dirname(documentPath), `${IMAGE_NAME}.png`);
    const link = `![${IMAGE_NAME}.png](./${IMAGE_NAME}.png)`;
    await shown.keyboard.press("Control+s");
    const text = await textThat(documentPath, (contents) => contents.includes(link));
    screenshots.set("pasted-image.png", await shown.screenshot());
    assert.ok(text.includes(link), `the document has no link to the image: ${text}`);
    const image = await readFile(imagePath);
    assert.deepEqual(image.subarray(0, 8), PNG_SIGNATURE, "the image file is a PNG");
  });
});

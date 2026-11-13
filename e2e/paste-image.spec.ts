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
 *                  an image link to it. A name that a file has, and an empty
 *                  name, are refused: no file changes, and
 *                  the window shows the cause (#210).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-paste-image-e2e-latest");
const DOCUMENT = "# Orbits\n\nThe orbit of a point.\n";
const IMAGE_NAME = "orbit-diagram";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

/** The bytes of an image of the author that a paste must keep. */
const AUTHOR_FIGURE = "the figure of the author";

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

  /** Copies an image to the clipboard, pastes it, and saves it under a name. */
  async function pasteImageAs(shown: Page, name: string): Promise<void> {
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
    screenshots.set(`paste-image-window-${name}.png`, await modal.screenshot());
    await modal.locator("#paste-image input[type='text']").first().fill(name);
    await modal.locator("#statusbar button", { hasText: "Save" }).click();
  }

  /** Waits until the window shows one more error message than before. */
  async function newErrorToast(shown: Page, before: number): Promise<number> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await shown.locator(ERROR_TOAST).count()) <= before) {
      await delay(120);
    }
    return (await shown.locator(ERROR_TOAST).count()) - before;
  }

  it("saves the image beside the document and links it", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    await pasteImageAs(shown, IMAGE_NAME);

    const imagePath = path.join(path.dirname(documentPath), `${IMAGE_NAME}.png`);
    const link = `![${IMAGE_NAME}.png](./${IMAGE_NAME}.png)`;
    // The editor inserts the link when the command answers; the author saves after that.
    await shown
      .locator(".cm-content", { hasText: `./${IMAGE_NAME}.png` })
      .waitFor({ state: "visible", timeout: 10_000 });
    // File → Save: the menu item that Ctrl+S runs.
    await shown.locator(".cm-content").click();
    await shown.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
    });
    const text = await textThat(documentPath, (contents) => contents.includes(link));
    screenshots.set("pasted-image.png", await shown.screenshot());
    assert.ok(text.includes(link), `the document has no link to the image: ${text}`);
    const image = await readFile(imagePath);
    assert.deepEqual(image.subarray(0, 8), PNG_SIGNATURE, "the image file is a PNG");
  });

  it("keeps a file that has the name of the pasted image", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const figure = path.join(path.dirname(documentPath), "figure.png");
    await writeFile(figure, AUTHOR_FIGURE);
    const before = await shown.locator(ERROR_TOAST).count();

    await pasteImageAs(shown, "figure");

    const shownMessages = await newErrorToast(shown, before);
    screenshots.set("refused-existing-name.png", await shown.screenshot());
    assert.equal(await readFile(figure, "utf8"), AUTHOR_FIGURE, "the file of the author is kept");
    assert.equal(shownMessages, 1, "the window shows the refusal one time");
    assert.equal(
      (await shown.locator(".cm-content").innerText()).includes("figure.png"),
      false,
      "the editor has no link to a file that the paste did not write",
    );
  });

  it("refuses an empty name", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const folder = path.dirname(documentPath);
    const filesBefore = await readdir(folder);
    const before = await shown.locator(ERROR_TOAST).count();

    await pasteImageAs(shown, "");

    const shownMessages = await newErrorToast(shown, before);
    screenshots.set("refused-empty-name.png", await shown.screenshot());
    const filesAfter = await readdir(folder);
    assert.deepEqual(
      filesAfter.sort(),
      filesBefore.sort(),
      `the paste makes no file: ${filesAfter.join(", ")}`,
    );
    assert.equal(shownMessages, 1, "the window shows the refusal one time");
    assert.equal(
      (await shown.locator(".cm-content").innerText()).includes("./.png"),
      false,
      "the editor has no link to a file that the paste did not write",
    );
  });
});

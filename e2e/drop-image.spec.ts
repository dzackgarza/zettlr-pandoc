/**
 * Assembled-app proof that an image file dropped on the editor becomes an
 * image link to that file. The type of a file is the type that its extension
 * names, whatever its case: `photo.webp` and `Figure.PNG` are images (#203).
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  shutdown,
} from "./support/electron-app";

// A PNG and a lossless WebP of one pixel each.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

describe("assembled app: drop of an image file on the editor", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-drop-image-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    await writeFile(path.join(path.dirname(documentPath), "photo.webp"), WEBP);
    await writeFile(path.join(path.dirname(documentPath), "Figure.PNG"), PNG);
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-drop-image-e2e-latest"),
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assertCleanExit(getOutput());
  });

  it("inserts an image link for each dropped image file", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    const folder = path.dirname(documentPath);

    // A file input gives the page File objects of files on disk, as a drop
    // from the file manager of the desktop does. Playwright's setInputFiles
    // over a CDP attach makes File objects in memory, which have no path;
    // DOM.setFileInputFiles gives the files on disk.
    await editorPage.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.id = "drop-source";
      input.style.display = "none";
      document.body.appendChild(input);
    });
    const session = await editorPage.context().newCDPSession(editorPage);
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#drop-source",
    });
    const dropped = [path.join(folder, "photo.webp"), path.join(folder, "Figure.PNG")];
    await session.send("DOM.setFileInputFiles", { nodeId, files: dropped });
    await session.detach();
    const pathsInPage = await editorPage.evaluate(() => {
      const input = document.getElementById("drop-source") as HTMLInputElement;
      return Array.from(input.files ?? []).map((file) => window.getPathForFile(file) ?? "");
    });
    assert.deepEqual(pathsInPage, dropped, "the page has the dropped files as files on disk");

    await editorPage.evaluate(() => {
      const input = document.getElementById("drop-source") as HTMLInputElement;
      const transfer = new DataTransfer();
      for (const file of Array.from(input.files ?? [])) {
        transfer.items.add(file);
      }
      const content = document.querySelector(".cm-content") as HTMLElement;
      const box = content.getBoundingClientRect();
      content.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          clientX: box.left + 4,
          clientY: box.bottom - 4,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
    });
    const expected = "# Note\n\n![photo.webp](photo.webp)\n![Figure.PNG](Figure.PNG)";
    const deadline = Date.now() + 5_000;
    let written = await readFile(documentPath, "utf8");
    while (written !== expected && Date.now() < deadline) {
      await delay(50);
      written = await readFile(documentPath, "utf8");
    }
    screenshots.set("after-drop.png", await editorPage.screenshot());
    assert.equal(written, expected, "each dropped image is an image link to its file");
  });
});

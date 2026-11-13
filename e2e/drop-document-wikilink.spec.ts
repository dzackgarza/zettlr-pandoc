/**
 * Assembled-app proof that a document dragged from the file manager onto the
 * editor becomes a wikilink that names that document alone: the written
 * form of the link index (#203). A drop of `a/intro.md`, beside
 * `b/intro.md`, writes `[[a/intro]]`; the file name alone would name both.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

describe("assembled app: drop of a document on the editor", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-drop-document-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    const workspace = path.dirname(documentPath);
    for (const folder of ["a", "b"]) {
      await mkdir(path.join(workspace, folder));
      await writeFile(path.join(workspace, folder, "intro.md"), `# Intro ${folder}\n`, "utf8");
    }
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
      path.join(tmpdir(), "zettlr-drop-document-e2e-latest"),
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

  it("inserts the wikilink that names the dropped document alone", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    const dropped = path.join(path.dirname(documentPath), "a", "intro.md");

    // The link index lists both documents before the drop
    const deadline = Date.now() + 10_000;
    let indexed = false;
    while (!indexed && Date.now() < deadline) {
      const targets: Record<string, string> = await editorPage.evaluate(() =>
        window.ipc.invoke("link-provider", { command: "get-link-targets" }),
      );
      indexed = Object.keys(targets).length === 3;
      if (!indexed) {
        await delay(100);
      }
    }
    assert.ok(indexed, "the link index holds the three documents of the workspace");

    // The data of a file manager row at the start of a drag (FileItem.vue)
    await editorPage.evaluate((filePath) => {
      const transfer = new DataTransfer();
      transfer.setData(
        "text/x-zettlr-file",
        JSON.stringify({ type: "file", path: filePath, id: "" }),
      );
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
    }, dropped);

    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
    });
    const expected = "# Note\n\n[[a/intro]]";
    const saveDeadline = Date.now() + 5_000;
    let written = await readFile(documentPath, "utf8");
    while (written !== expected && Date.now() < saveDeadline) {
      await delay(50);
      written = await readFile(documentPath, "utf8");
    }
    screenshots.set("after-drop.png", await editorPage.screenshot());
    assert.equal(written, expected, "the dropped document is linked by the form that names it");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a document whose first load fails
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace holds a file that the application cannot
 *                  read. The application starts, and the file manager lists
 *                  the file with the cause. A second file becomes unreadable
 *                  after the start, and the author opens it: the pane has a
 *                  tab and no editor, and the message names the file and
 *                  offers the action that loads the document again. After
 *                  the file is readable, that action shows its text, and
 *                  the file manager shows the file without a cause.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
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
import { leafIds, openInLeaf } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-document-load-retry-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const OTHER = "# Genera\n\nTwo forms of one genus are isometric over each completion.\n";
const LATE = "# Orbits\n\nThe orbit of a point has the index of its stabilizer as its size.\n";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The editor of the tab that a pane shows; a pane keeps a hidden editor for each other tab. */
const EDITOR = ".cm-content:visible";

describe("a document whose first load fails", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let otherPath = "";
  let latePath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-document-load-retry-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
    });
    fixtureRoot = fixture.root;
    otherPath = path.join(path.dirname(fixture.documentPath), "other.md");
    await writeFile(otherPath, OTHER);
    await chmod(otherPath, 0o000);
    latePath = path.join(path.dirname(fixture.documentPath), "orbits.md");
    await writeFile(latePath, LATE);
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(EDITOR).waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    for (const restored of [otherPath, latePath]) {
      if (restored !== "") {
        await chmod(restored, 0o600);
      }
    }
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

  /** The row of a file in the file manager. */
  function treeRow(editorPage: Page, filePath: string): Locator {
    return editorPage.locator(`#file-manager .tree-item[data-path="${filePath}"]`);
  }

  it("lists the file with the cause", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const row = treeRow(editorPage, otherPath);
    await row.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("listed.png", await editorPage.screenshot());
    assert.equal(
      await row.getAttribute("data-read-error"),
      "EACCES",
      "the row of the file carries the cause",
    );
    const title = await row.locator(".display-text").getAttribute("title");
    assert.ok(title?.includes("EACCES"), `the row tells the author the cause: ${title}`);
    assert.equal(
      await treeRow(editorPage, path.join(path.dirname(otherPath), "note.md")).getAttribute(
        "data-read-error",
      ),
      null,
      "a file that was read has no cause",
    );
  });

  it("offers the action that loads the document again", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    // The file was readable when the app started: the start and the index of
    // the workspace do not see the refusal. Its first load does.
    await treeRow(editorPage, latePath).waitFor({ state: "visible", timeout: 30_000 });
    await chmod(latePath, 0o000);
    const [leaf] = await leafIds(editorPage);
    await openInLeaf(editorPage, requireInitialized(leaf, "The window has a pane"), latePath);

    const toast = editorPage.locator(ERROR_TOAST).filter({ hasText: "orbits.md" });
    await toast.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("load-failed.png", await editorPage.screenshot());
    assert.equal(await toast.count(), 1, "one failed load shows one message");
    assert.equal(
      await editorPage.locator(EDITOR).count(),
      0,
      "the pane of a document that did not load shows no editor",
    );
    const retry = toast.locator("[data-toast-action]");
    assert.equal(await retry.count(), 1, "the message has an action");
    assert.equal(await retry.innerText(), "Try again", "the action loads the document again");

    await chmod(latePath, 0o600);
    await retry.click();
    await editorPage
      .locator(EDITOR)
      .filter({ hasText: "The orbit of a point" })
      .waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("loaded.png", await editorPage.screenshot());
    assert.equal(
      await editorPage.locator(ERROR_TOAST).count(),
      0,
      "the window shows no error after the load",
    );
    const row = treeRow(editorPage, latePath);
    const deadline = Date.now() + 30_000;
    while ((await row.getAttribute("data-read-error")) !== null) {
      assert.ok(Date.now() < deadline, "the file manager shows the file without a cause");
      await delay(250);
    }
    screenshots.set("listed-after-load.png", await editorPage.screenshot());
  });
});

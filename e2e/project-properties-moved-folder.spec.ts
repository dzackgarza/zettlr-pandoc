/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of the Project properties window of a
 *                  folder that is gone
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The folder `book` of the workspace is a Project. The
 *                  author opens its properties, and another program moves
 *                  the folder. A change in the open window cannot reach the
 *                  settings: the window says why. A properties window that
 *                  opens for the old path cannot load the settings: it shows
 *                  the cause in place of the form, which takes no change.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { findProjectPropertiesPage } from "./support/project-properties";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-project-properties-moved-folder-e2e-latest");
const BOOK_SETTINGS = {
  sorting: "name-up",
  project: {
    title: "Book",
    profiles: [],
    files: ["chapter.md"],
    cslStyle: "",
    templates: { tex: "", html: "" },
  },
  icon: null,
  color: null,
};
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The time in which the message of a refused change arrives. */
const MESSAGE_MS = 5_000;
/** The time in which a second message of one failure arrives. */
const SECOND_MESSAGE_MS = 2_000;

/** The error messages of a window once a refused change had time to show one. */
async function settledErrorMessages(page: Page): Promise<string[]> {
  const deadline = Date.now() + MESSAGE_MS;
  while (Date.now() < deadline && (await page.locator(ERROR_TOAST).count()) === 0) {
    await delay(100);
  }
  await delay(SECOND_MESSAGE_MS);
  return await page.locator(`${ERROR_TOAST} span:first-child`).allInnerTexts();
}

describe("the Project properties window of a folder that is gone", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let propertiesPage: Page | undefined;
  let fixtureRoot: string | undefined;
  let book = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-project-properties-moved-folder-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    book = path.join(path.dirname(fixture.documentPath), "book");
    await mkdir(book);
    await writeFile(path.join(book, ".ztr-directory"), JSON.stringify(BOOK_SETTINGS), "utf8");
    await writeFile(path.join(book, "chapter.md"), "# Chapter\n", "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    // The application quits when its last window closes, so the Project
    // properties window closes before the main window does.
    if (propertiesPage !== undefined && !propertiesPage.isClosed()) {
      const closed = propertiesPage.waitForEvent("close", { timeout: 10_000 });
      await requestWindowClose(propertiesPage);
      await closed;
    }
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
    assertCleanExit(getOutput());
  });

  it("says why a change cannot reach the settings of a moved folder", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const runningBrowser = requireInitialized(browser, "The application must be running");
    await editorPage.evaluate(
      async (payload) =>
        await window.ipc.invoke("application", { command: "open-project-preferences", payload }),
      book,
    );
    propertiesPage = await findProjectPropertiesPage(runningBrowser, 30_000);
    const titleInput = propertiesPage.getByLabel("Project Title");
    await titleInput.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await titleInput.inputValue(), "Book", "the window shows the settings");

    await rename(book, `${book}-moved`);
    await titleInput.fill("A title of a moved folder");

    const messages = await settledErrorMessages(propertiesPage);
    screenshots.set("moved-folder-change.png", await propertiesPage.screenshot());
    assert.deepEqual(messages, [
      `Could not update the Project settings: There is no file or folder at ${book}.`,
    ]);
  });

  it("shows why it cannot load the settings in place of the form", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const runningBrowser = requireInitialized(browser, "The application must be running");
    const open = requireInitialized(propertiesPage, "The properties window must be open");
    const closed = open.waitForEvent("close", { timeout: 10_000 });
    await requestWindowClose(open);
    await closed;

    // The command that the properties of a folder row send.
    await editorPage.evaluate(
      async (payload) =>
        await window.ipc.invoke("application", { command: "open-project-preferences", payload }),
      book,
    );
    propertiesPage = await findProjectPropertiesPage(runningBrowser, 30_000);
    await delay(SECOND_MESSAGE_MS);

    const failure = propertiesPage.locator(".load-failure");
    const shown = (await failure.count()) > 0 ? await failure.innerText() : "";
    screenshots.set("moved-folder-load.png", await propertiesPage.screenshot());
    assert.equal(
      shown,
      `Could not load the Project settings: There is no file or folder at ${book}.`,
    );
    assert.equal(
      await propertiesPage.getByLabel("Project Title").isVisible(),
      false,
      "the window offers no field that takes a change",
    );
  });
});

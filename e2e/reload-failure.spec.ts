/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a document that cannot be read again
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A loaded document changes on disk, and the file cannot be
 *                  read. The window shows the cause one time, with the
 *                  action that loads the file again: one time for a document
 *                  that two panes show, and one time for a document in a tab
 *                  that no pane shows.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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
import { leafIds, openInLeaf, splitAndOpen } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-reload-failure-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const OTHER = "# Genera\n\nTwo forms of one genus are isometric over each completion.\n";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The editor of the tab that a pane shows; a pane keeps a hidden editor for each other tab. */
const EDITOR = ".cm-content:visible";
/** The window shows each broadcast of a failed reload within this time. */
const EVERY_MESSAGE_SHOWN_MS = 3_000;
/** The provider reports no second failure of one file for one second. */
const NEXT_FAILURE_REPORTED_MS = 1_500;

describe("a loaded document that changed on disk and cannot be read", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notePath = "";
  let otherPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();
  let changes = 0;

  /** Makes the file of the note unreadable and newer than the loaded text. */
  async function changeToUnreadable(): Promise<void> {
    changes += 1;
    await chmod(notePath, 0o000);
    const changedAt = new Date(Date.now() + changes * 60_000);
    await utimes(notePath, changedAt, changedAt);
  }

  /** Makes the file readable again and removes the messages of the window. */
  async function restore(): Promise<void> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await chmod(notePath, 0o600);
    const toasts = editorPage.locator(ERROR_TOAST);
    while ((await toasts.count()) > 0) {
      await toasts.first().locator('button[aria-label="Dismiss"]').click();
      await delay(250);
    }
    await delay(NEXT_FAILURE_REPORTED_MS);
  }

  /** Waits until this many panes show the text of a document. */
  async function panesShow(editorPage: Page, text: string, count: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while ((await editorPage.locator(EDITOR).filter({ hasText: text }).count()) !== count) {
      assert.ok(Date.now() < deadline, `${count} panes show "${text}"`);
      await delay(250);
    }
  }

  before(async function () {
    const fixture = await createFixture("zettlr-reload-failure-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
    });
    fixtureRoot = fixture.root;
    notePath = fixture.documentPath;
    otherPath = path.join(path.dirname(notePath), "other.md");
    await writeFile(otherPath, OTHER);
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(EDITOR).waitFor({ state: "visible", timeout: this.timeout() });
  });

  afterEach(restore);

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

  it("shows one message for a document that two panes show", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await splitAndOpen(editorPage, notePath);
    await panesShow(editorPage, "Lattices", 2);

    await changeToUnreadable();
    const toasts = editorPage.locator(ERROR_TOAST);
    await toasts.first().waitFor({ state: "visible", timeout: 30_000 });
    await delay(EVERY_MESSAGE_SHOWN_MS);
    screenshots.set("two-panes.png", await editorPage.screenshot());

    assert.equal(await toasts.count(), 1, "one failed reload shows one message");
    const message = await toasts.first().locator("span:first-child").innerText();
    assert.ok(message.includes("note.md"), `the message names the file: ${message}`);
    assert.equal(
      await toasts.first().locator("[data-toast-action]").innerText(),
      "Load from disk",
      "the message has the action that loads the file again",
    );
  });

  it("shows the message for a document in a tab that no pane shows", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    for (const leaf of await leafIds(editorPage)) {
      await openInLeaf(editorPage, leaf, otherPath);
    }
    await panesShow(editorPage, "Genera", 2);
    await panesShow(editorPage, "Lattices", 0);

    await changeToUnreadable();
    const toasts = editorPage.locator(ERROR_TOAST);
    await toasts.first().waitFor({ state: "visible", timeout: 30_000 });
    await delay(EVERY_MESSAGE_SHOWN_MS);
    screenshots.set("background-tab.png", await editorPage.screenshot());

    assert.equal(await toasts.count(), 1, "one failed reload shows one message");
    const message = await toasts.first().locator("span:first-child").innerText();
    assert.ok(message.includes("note.md"), `the message names the file: ${message}`);
  });
});

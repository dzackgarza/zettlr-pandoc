/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of an open request for a file that does not exist
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author follows a Markdown link to a file that does not
 *                  exist. The window names the path in one message, and the
 *                  document stays the active one.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-open-missing-file-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const DOCUMENT = "# Genus\n\nThe proof is in [the lemma](lemma.md).\n";

describe("an open request for a file that does not exist", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let missing = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-open-missing-file-e2e-", {
      documentName: "genus.md",
      documentContents: DOCUMENT,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    missing = path.join(path.dirname(fixture.documentPath), "lemma.md");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
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

  it("names the path of a link to a file that does not exist", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The editor draws the link as its label; a Ctrl-click on the label follows it.
    const link = activePage.locator(".cm-preview-link", { hasText: "the lemma" });
    await link.waitFor({ state: "visible", timeout: 30_000 });
    await link.click({ modifiers: ["Control"] });

    const error = activePage.locator(`${ERROR_TOAST} span:first-child`);
    await error.first().waitFor({ state: "visible", timeout: 20_000 });
    // The window gets no second message for the same refusal.
    await delay(1000);
    screenshots.set("missing-file.png", await activePage.screenshot());
    const messages = await error.allInnerTexts();
    assert.equal(messages.length, 1, "the window shows one message");
    assert.ok(messages[0].includes(missing), `the message names the path: ${messages[0]}`);
    assert.equal(messages[0].split("\n").length, 1, `the message holds no stack: ${messages[0]}`);
    assert.equal(
      await activePage.locator(".cm-line", { hasText: "The proof is in" }).count(),
      1,
      "the document stays the active one",
    );
  });
});

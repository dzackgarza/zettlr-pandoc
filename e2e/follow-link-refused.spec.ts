/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a link that cannot be followed
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author follows a Markdown link to a file that does not
 *                  exist, and a link to a web page while the desktop opens
 *                  nothing: the `xdg-open` of the run stops with an error.
 *                  The window names the target in one message, and the
 *                  document stays the active one.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-follow-link-refused-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const WEB_PAGE = "https://example.org/genus";
const DOCUMENT = `# Genus\n\nThe proof is in [the lemma](lemma.md).\n\nThe table is on [the web](${WEB_PAGE}).\n`;

describe("a link that cannot be followed", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let missing = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-follow-link-refused-e2e-", {
      documentName: "genus.md",
      documentContents: DOCUMENT,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    missing = path.join(path.dirname(fixture.documentPath), "lemma.md");

    // The desktop of the run opens nothing.
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    const xdgOpen = path.join(bin, "xdg-open");
    await writeFile(xdgOpen, '#!/bin/sh\necho "no application opens $1" >&2\nexit 4\n', "utf8");
    await chmod(xdgOpen, 0o755);

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout(), {
      environment: { PATH: `${bin}:${process.env.PATH}` },
    });
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

  /**
   * Ctrl-clicks the label of a link, which the editor draws in place of its
   * source, and gives the messages of the window one second after the first.
   */
  async function follow(label: string, screenshot: string): Promise<string[]> {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const error = activePage.locator(`${ERROR_TOAST} span:first-child`);
    for (const close of await activePage
      .locator(`${ERROR_TOAST} button[aria-label="Dismiss"]`)
      .all()) {
      await close.click();
    }
    await error.first().waitFor({ state: "detached", timeout: 10_000 });

    const link = activePage.locator(".cm-preview-link", { hasText: label });
    await link.waitFor({ state: "visible", timeout: 30_000 });
    // A locator click waits for the navigation that the click starts, and the
    // application stops that navigation; the mouse of the page does not wait.
    const box = await link.boundingBox();
    if (box === null) {
      throw new Error(`The link "${label}" has no box`);
    }
    await activePage.keyboard.down("Control");
    await activePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await activePage.keyboard.up("Control");

    await error.first().waitFor({ state: "visible", timeout: 20_000 });
    // The window gets no second message for the same refusal.
    await delay(1000);
    screenshots.set(screenshot, await activePage.screenshot());
    assert.equal(
      await activePage.locator(".cm-line", { hasText: "The proof is in" }).count(),
      1,
      "the document stays the active one",
    );
    return await error.allInnerTexts();
  }

  it("names the path of a link to a file that does not exist", async function () {
    const messages = await follow("the lemma", "missing-file.png");
    assert.equal(messages.length, 1, "the window shows one message");
    assert.ok(messages[0].includes(missing), `the message names the path: ${messages[0]}`);
    assert.equal(messages[0].split("\n").length, 1, `the message holds no stack: ${messages[0]}`);
  });

  it("names the address of a web link that the desktop does not open", async function () {
    const messages = await follow("the web", "web-refused.png");
    assert.equal(messages.length, 1, "the window shows one message");
    assert.ok(messages[0].includes(WEB_PAGE), `the message names the address: ${messages[0]}`);
  });
});

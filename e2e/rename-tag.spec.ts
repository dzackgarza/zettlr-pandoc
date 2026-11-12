/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a tag rename in the tag manager
 *
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author renames a tag in the tag manager. The tag is in
 *                  a keyword list that also holds a number, in a keyword
 *                  value that a comma divides, as an inline tag, and in a
 *                  file that the author cannot write. The new name has a
 *                  space, so the inline tag goes into the front matter. Each
 *                  file that the application can write gets the new name;
 *                  the tag manager names the file that it could not change.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
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
import { captureWindow, nativeDialog, pressKey } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-rename-tag-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const LOCKED = "# Locked\n\nA #lattice-theory note that the author cannot write.\n";

async function findTagManagerPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator("#tag-manager").count()) > 0) {
          return page;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No tag manager window appeared within ${timeoutMs}ms`);
}

/** The text of a file when it is the expected text, or its text ten seconds later. */
async function textThat(file: string, expected: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await readFile(file, "utf8");
  while (Date.now() < deadline && !expected(text)) {
    await delay(100);
    text = await readFile(file, "utf8");
  }
  return text;
}

describe("a tag rename in the tag manager", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let comma = "";
  let numbers = "";
  let inline = "";
  let locked = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-rename-tag-e2e-", {
      documentName: "comma.md",
      documentContents: "---\nkeywords: algebra, lattice-theory\n---\n\n# Comma\n\nA note.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    const workspace = path.dirname(fixture.documentPath);
    comma = fixture.documentPath;
    numbers = path.join(workspace, "numbers.md");
    inline = path.join(workspace, "inline.md");
    locked = path.join(workspace, "locked.md");
    await writeFile(
      numbers,
      "---\nkeywords:\n- 1997\n- lattice-theory\n---\n\n# Numbers\n",
      "utf8",
    );
    await writeFile(inline, "# Inline\n\nA #lattice-theory note.\n", "utf8");
    await writeFile(locked, LOCKED, "utf8");
    await chmod(locked, 0o444);

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

  it("gives each writable file the new name and names the file it could not change", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.tags" });
    });
    const manager = await findTagManagerPage(requireInitialized(browser, "browser"), 30_000);
    const row = manager
      .locator("tr.tag-flex")
      .filter({ has: manager.locator("td:first-child span", { hasText: /^lattice-theory$/ }) });
    await row.waitFor({ state: "visible", timeout: 30_000 });
    await row.getByRole("button", { name: "Rename tag…" }).click();
    await row.locator("input").fill("lattice theory");
    await row.getByRole("button", { name: "Rename", exact: true }).click();

    const prompt = await nativeDialog("Confirm", 30_000);
    screenshots.set("confirm.png", await captureWindow(prompt));
    await pressKey(prompt, "shift+Tab");
    await pressKey(prompt, "Return");

    const error = manager.locator(`${ERROR_TOAST} span:first-child`);
    await error.first().waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("refused.png", await manager.screenshot());
    const messages = await error.allInnerTexts();
    assert.equal(messages.length, 1, "the tag manager shows one message");
    assert.ok(messages[0].includes(locked), "the message names the file that it could not change");

    assert.equal(
      await textThat(comma, (text) => !text.includes("lattice-theory")),
      "---\nkeywords: algebra, lattice theory\n---\n\n# Comma\n\nA note.\n",
    );
    assert.equal(
      await textThat(numbers, (text) => !text.includes("lattice-theory")),
      "---\nkeywords:\n- 1997\n- lattice theory\n---\n\n# Numbers\n",
    );
    assert.equal(
      await textThat(inline, (text) => !text.includes("lattice-theory")),
      "---\nkeywords:\n  - lattice theory\n---\n\n# Inline\n\nA  note.\n",
    );
    await chmod(locked, 0o644);
    assert.equal(await readFile(locked, "utf8"), LOCKED);
  });
});

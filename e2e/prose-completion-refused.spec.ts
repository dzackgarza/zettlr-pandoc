/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Refused prose completion entry E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author chooses "Add to prose completion dictionary"
 *                  in the context menu of a word while the completion file
 *                  refuses writes. The window shows one message that names
 *                  the file, and the file keeps its text (#210).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-prose-completion-refused-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const COMPLETIONS = "# Phrases of the author\non the other hand\n";

describe("assembled app: a prose completion entry that the file refuses", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let completionDirectory: string | undefined;
  let completionFile = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    completionDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-prose-completion-refused-"));
    completionFile = path.join(completionDirectory, "prose.txt");
    await writeFile(completionFile, COMPLETIONS, "utf8");
    const fixture = await createFixture("zettlr-prose-completion-refused-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo lattices of one genus.\n",
      config: { darkMode: false, editor: { proseCompletionFile: completionFile } },
    });
    fixtureRoot = fixture.root;

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
    if (completionDirectory !== undefined) {
      await rm(completionDirectory, { recursive: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  it("names the file in the window and keeps its text", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    await chmod(completionFile, 0o400);

    await shown.locator(".cm-line", { hasText: "lattices" }).getByText("lattices").click({
      button: "right",
    });
    await shown
      .locator(".application-menu .menu-item")
      .filter({
        has: shown.locator(".label", { hasText: /^Add to prose completion dictionary$/ }),
      })
      .click();

    const toast = shown.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("refused-entry.png", await shown.screenshot());
    assert.equal(await toast.count(), 1, "one message for one refused entry");
    assert.match(await toast.first().innerText(), /prose\.txt/);
    assert.equal(await readFile(completionFile, "utf8"), COMPLETIONS);
  });
});

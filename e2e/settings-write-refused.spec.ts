/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a change of a setting that the disk refuses
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The application writes the settings to config.json one
 *                  second after their last change. Here a folder stands at
 *                  the path of config.json, so the write fails. The author
 *                  gets one error window that names the file: the change
 *                  holds only until the application closes.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  clickToClose,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-settings-write-refused-e2e-latest");

/** The time in which a second error window of one write appears. */
const SECOND_WINDOW_MS = 3_000;

/** Each open error window of the application. */
async function errorWindows(browser: Browser): Promise<Page[]> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const counts = await Promise.all(pages.map(async (page) => await page.locator("#error").count()));
  return pages.filter((_page, index) => counts[index] > 0);
}

describe("a change of a setting that the disk refuses", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let configFile = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-settings-write-refused-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    configFile = path.join(fixture.configDirectory, "config.json");

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

  it("names config.json in one error window", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");

    // A folder at the path of the file: the rename of the write fails.
    await rename(configFile, `${configFile}.moved`);
    await mkdir(configFile);

    // The call that a field of the Preferences window makes.
    const refusal = await editorPage.evaluate(() =>
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: { key: "editor.fontSize", val: 19 },
      }),
    );
    assert.equal(refusal, null, "the application takes the new value");

    const deadline = Date.now() + 30_000;
    while ((await errorWindows(running)).length === 0) {
      assert.ok(Date.now() < deadline, "no error window appeared within 30 s");
      await delay(100);
    }
    await delay(SECOND_WINDOW_MS);
    const open = await errorWindows(running);
    assert.equal(open.length, 1, "one refused write opens one error window");
    const [shown] = open;
    await shown.locator("#error").waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("settings-write-refused.png", await shown.screenshot());
    const text = await shown.locator("#error").innerText();
    assert.ok(text.includes(configFile), `the error window does not name ${configFile}:\n${text}`);

    await clickToClose(shown, shown.getByRole("button", { name: "Ok" }));
  });
});

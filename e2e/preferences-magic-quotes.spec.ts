/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The Magic Quotes fields of the Preferences (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A typed quote is a MagicQuote only while autocorrect is
 *                  on. With autocorrect off, the Preferences show the quote
 *                  pairs and offer no choice, as the status bar menu does
 *                  (#204); the switch of the Autocorrect fieldset makes the
 *                  fields take input again.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { PreferencesGroups } from "../source/types/common/preferences";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-preferences-magic-quotes-e2e-latest");
const FIELDSET = "Magic Quotes";
const QUOTE_FIELDS = ["Double/Primary Quotes", "Single/Secondary Quotes"];

/** The Preferences window, when it is open. */
function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

/** Whether each quote field of the Preferences is disabled. */
async function quoteFieldsDisabled(preferences: Page): Promise<boolean[]> {
  const fieldset = preferences.locator(`[data-form-fieldset-title="${FIELDSET}"]`);
  return await Promise.all(QUOTE_FIELDS.map((label) => fieldset.getByLabel(label).isDisabled()));
}

describe("the Magic Quotes fields of the Preferences", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-preferences-magic-quotes-e2e-", {
      documentName: "note.md",
      documentContents: '# Genus\n\n"Two forms of one genus."\n',
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
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

  it("offers a quote pair only while autocorrect is on", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");
    await editorPage.evaluate(() => {
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: { key: "editor.autoCorrect.active", val: false },
      });
    });
    await editorPage.evaluate(
      async (target) => {
        await window.ipc.invoke("application", { command: "open-preferences", payload: target });
      },
      { group: PreferencesGroups.Autocorrect, fieldsetTitle: FIELDSET },
    );
    const deadline = Date.now() + 20_000;
    let preferences = preferencesPage(running);
    while (preferences === undefined) {
      assert.ok(Date.now() < deadline, "the Preferences window opens");
      await delay(100);
      preferences = preferencesPage(running);
    }
    const fieldset = preferences.locator(`[data-form-fieldset-title="${FIELDSET}"]`);
    await fieldset.getByLabel(QUOTE_FIELDS[0]).waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("autocorrect-off.png", await preferences.screenshot());
    assert.deepEqual(
      await quoteFieldsDisabled(preferences),
      [true, true],
      "with autocorrect off, no quote field takes input",
    );

    await editorPage.evaluate(() => {
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: { key: "editor.autoCorrect.active", val: true },
      });
    });
    await preferences.waitForFunction(
      (title) => !document.querySelector(`[data-form-fieldset-title="${title}"] select:disabled`),
      FIELDSET,
      { timeout: 10_000 },
    );
    screenshots.set("autocorrect-on.png", await preferences.screenshot());
    assert.deepEqual(await quoteFieldsDisabled(preferences), [false, false]);
    await preferences.close();
  });
});

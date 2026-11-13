/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a Preferences value that the settings refuse
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The main process checks each value of the Preferences
 *                  window against the rule of its setting and keeps the old
 *                  value when the rule refuses it. The field shows the author
 *                  that the value is not saved and why; the next value that
 *                  the rule accepts is saved and removes the message.
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
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-preferences-refused-value-e2e-latest");
const FIELDSET = "Zettelkasten IDs";
const LABEL = "Pattern for generating new IDs";
const SAVED_PATTERN = "%Y%M%D%h%m%s";

/** The Preferences window, when it is open. */
function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

describe("a Preferences value that the rule of its setting refuses", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-preferences-refused-value-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false, zkn: { idGen: SAVED_PATTERN } },
    });
    fixtureRoot = fixture.root;
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

  /** The ID pattern that the main process holds. */
  async function savedPattern(): Promise<string> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    return await editorPage.evaluate(() =>
      window.ipc.sendSync("config-provider", {
        command: "get-config",
        payload: { key: "zkn.idGen" },
      }),
    );
  }

  it("shows at the field that a refused value is not saved", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");
    await editorPage.evaluate(
      async (target) => {
        await window.ipc.invoke("application", { command: "open-preferences", payload: target });
      },
      { group: PreferencesGroups.Zettelkasten, fieldsetTitle: FIELDSET },
    );
    const deadline = Date.now() + 20_000;
    let preferences = preferencesPage(running);
    while (preferences === undefined) {
      assert.ok(Date.now() < deadline, "the Preferences window opens");
      await delay(100);
      preferences = preferencesPage(running);
    }
    const fieldset = preferences.locator(`[data-form-fieldset-title="${FIELDSET}"]`);
    const field = fieldset.getByLabel(LABEL);
    await field.waitFor({ state: "visible", timeout: 20_000 });

    // The rule of zkn.idGen asks for at least two characters.
    await field.fill("X");
    const refusal = fieldset.getByRole("alert");
    await refusal.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("refused-value.png", await preferences.screenshot());
    assert.equal(await savedPattern(), SAVED_PATTERN, "the refused value is not saved");
    assert.equal(await field.inputValue(), "X", "the field keeps what the author typed");

    await field.fill("%Y%M");
    await refusal.waitFor({ state: "detached", timeout: 10_000 });
    screenshots.set("accepted-value.png", await preferences.screenshot());
    assert.equal(await savedPattern(), "%Y%M", "the accepted value is saved");
    await preferences.close();
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unavailable QuickTeX E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the assembled app with `editor.quickTexFile` at a
 *                  file that is absent. The app starts without the QuickTeX
 *                  expansions. The main window names the file and the cause
 *                  and opens the setting, and the Preferences window marks
 *                  the field. A setting that names no configuration ends the
 *                  mark. A configuration that is there needs the plugin: the
 *                  window marks the plugin directory that has no plugin, and
 *                  the setting that names no directory.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-quicktex-unavailable-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const CONFIGURATION_FIELD = '[id="field-input-editor.quickTexFile"]';
const PLUGIN_FIELD_ID = "field-input-editor.quickTexPluginDirectory";

/** The message of the failure that an access of this absent file gives. */
async function accessFailure(file: string): Promise<string> {
  const error: Error = await access(file).then(
    () => new Error(`${file} is there`),
    (cause: Error) => cause,
  );
  return error.message;
}

async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await delay(100);
  }
  return await condition();
}

function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

/** The ids of the inputs whose fields the Preferences window marks as not loaded. */
function markedFields(preferences: Page): Promise<string[]> {
  return preferences.evaluate(() =>
    [...document.querySelectorAll(".file-problem")].map((mark) => {
      const input = mark.closest(".form-control")?.querySelector("input");
      if (input === null || input === undefined) {
        throw new Error("A problem mark is not in the field of an input");
      }
      return input.id;
    }),
  );
}

describe("assembled app: a QuickTeX configuration that cannot be loaded", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let resources = "";
  let missingConfiguration = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    resources = await mkdtemp(path.join(tmpdir(), "zettlr-quicktex-resources-"));
    const pluginDirectory = path.join(resources, "quicktex");
    await mkdir(pluginDirectory);
    missingConfiguration = path.join(resources, "unmounted", "quicktex_dict.vim");

    const fixture = await createFixture("zettlr-quicktex-unavailable-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n\nA sentence.\n",
      config: {
        editor: {
          quickTexFile: missingConfiguration,
          quickTexPluginDirectory: pluginDirectory,
        },
      },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    // The app runs while a window is open.
    await (browser === undefined ? undefined : preferencesPage(browser))?.close();
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
    await rm(resources, { recursive: true, force: true });
    assertCleanExit(getOutput());
  });

  it("starts, names the configuration and the cause, and opens the setting", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const cause = await accessFailure(missingConfiguration);

    const toast = editorPage.locator(ERROR_TOAST);
    const action = toast.first().locator("[data-toast-action]");
    await action.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("quicktex-problem-toast.png", await editorPage.screenshot());
    assert.equal(await toast.count(), 1, "one problem shows one message");
    const message = await toast.first().locator("span:first-child").innerText();
    assert.ok(message.includes("QuickTeX"), `the message names QuickTeX: ${message}`);
    assert.ok(message.includes(cause), `the message names the file and the cause: ${message}`);
    assert.equal(await action.innerText(), "Open Preferences");

    await action.click();
    const openBrowser = requireInitialized(browser, "The app must be attached");
    assert.ok(
      await until(async () => preferencesPage(openBrowser) !== undefined, 30_000),
      "the action opens the Preferences window",
    );
    const preferences = requireInitialized(
      preferencesPage(openBrowser),
      "The Preferences window must be open",
    );
    const field = preferences.locator(CONFIGURATION_FIELD);
    await field.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await field.inputValue(), missingConfiguration, "the window shows the setting");
    const mark = preferences.locator(".file-problem");
    await mark.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("quicktex-problem-preferences.png", await preferences.screenshot());
    assert.deepEqual(await markedFields(preferences), ["field-input-editor.quickTexFile"]);
    assert.ok(
      (await mark.innerText()).includes(cause),
      `the field names the cause: ${await mark.innerText()}`,
    );
  });

  it("marks no field when the setting names no configuration", async function () {
    const preferences = requireInitialized(
      preferencesPage(requireInitialized(browser, "The app must be attached")),
      "The Preferences window must be open",
    );

    await preferences.locator(CONFIGURATION_FIELD).fill("");

    assert.ok(
      await until(async () => (await markedFields(preferences)).length === 0, 30_000),
      "the field has no mark without a configuration",
    );
    screenshots.set("quicktex-no-configuration-preferences.png", await preferences.screenshot());
  });

  it("marks the plugin directory when the configuration is there and the plugin is not", async function () {
    const preferences = requireInitialized(
      preferencesPage(requireInitialized(browser, "The app must be attached")),
      "The Preferences window must be open",
    );
    const configuration = path.join(resources, "quicktex_dict.vim");
    await writeFile(configuration, "let g:quicktex_prose = {}\n");
    const cause = await accessFailure(path.join(resources, "quicktex", "plugin", "quicktex.vim"));
    const mark = preferences.locator(".file-problem");
    const markText = async (): Promise<string> =>
      (await mark.count()) === 1 ? await mark.innerText() : "";

    await preferences.locator(CONFIGURATION_FIELD).fill(configuration);

    assert.ok(
      await until(async () => (await markText()).includes(cause), 30_000),
      `the field names the absent plugin script: ${await markText()}`,
    );
    assert.deepEqual(await markedFields(preferences), [PLUGIN_FIELD_ID]);
    screenshots.set("quicktex-no-plugin-preferences.png", await preferences.screenshot());

    await preferences.locator(`[id="${PLUGIN_FIELD_ID}"]`).fill("");

    assert.ok(
      await until(
        async () => (await markText()).includes("no setting names the directory"),
        30_000,
      ),
      `the field says that the configuration needs a plugin directory: ${await markText()}`,
    );
    assert.deepEqual(await markedFields(preferences), [PLUGIN_FIELD_ID]);
    screenshots.set("quicktex-no-plugin-directory-preferences.png", await preferences.screenshot());
  });
});

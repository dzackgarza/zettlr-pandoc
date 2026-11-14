/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a Preferences button whose file the desktop does not open
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Two buttons of the Preferences window open a file or a
 *                  folder of completions with the application of the
 *                  desktop. Here the desktop opens nothing: the `xdg-open`
 *                  of the run stops with an error. Each click gives the
 *                  author one message in the Preferences window that names
 *                  the path.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-preferences-open-refused-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

/** The time in which a second message of one click appears. */
const SECOND_MESSAGE_MS = 2_000;

/** The Preferences window, when it is open. */
function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

describe("a Preferences button whose path the desktop does not open", function () {
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
    completionDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-preferences-completions-"));
    completionFile = path.join(completionDirectory, "prose.txt");
    const fixture = await createFixture("zettlr-preferences-open-refused-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false, editor: { proseCompletionFile: completionFile } },
    });
    fixtureRoot = fixture.root;

    // The desktop of the run opens nothing.
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    const xdgOpen = path.join(bin, "xdg-open");
    await writeFile(xdgOpen, '#!/bin/sh\necho "no application opens $1" >&2\nexit 4\n', "utf8");
    await chmod(xdgOpen, 0o755);

    const app = await attach(fixture.configDirectory, rendererEvents, {
      environment: { PATH: `${bin}:${process.env.PATH}` },
    });
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
    if (completionDirectory !== undefined) {
      await rm(completionDirectory, { recursive: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  /**
   * Opens one fieldset of the Preferences window, clicks its button and
   * gives the text of the one message that the click shows.
   */
  async function refusedClick(
    group: PreferencesGroups,
    fieldsetTitle: string,
    label: string,
  ): Promise<string> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");
    await editorPage.evaluate(
      async (target) => {
        await window.ipc.invoke("application", { command: "open-preferences", payload: target });
      },
      { group, fieldsetTitle },
    );
    const deadline = Date.now() + 20_000;
    let preferences = preferencesPage(running);
    while (preferences === undefined) {
      assert.ok(Date.now() < deadline, "the Preferences window opens");
      await delay(100);
      preferences = preferencesPage(running);
    }
    const button = preferences.locator(
      `[data-form-fieldset-title="${fieldsetTitle}"] button:has-text("${label}")`,
    );
    await button.waitFor({ state: "visible", timeout: 20_000 });
    await button.click();

    const toast = preferences.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 30_000 });
    await delay(SECOND_MESSAGE_MS);
    screenshots.set(`${group}-open-refused.png`, await preferences.screenshot());
    assert.equal(await toast.count(), 1, "one refused open shows one message");
    const text = await toast.first().innerText();
    await preferences.close();
    return text;
  }

  it("names the completion file that it could not open", async function () {
    const text = await refusedClick(
      PreferencesGroups.Spellchecking,
      "Prose completion dictionaries",
      "Open primary completion file",
    );
    assert.ok(
      text.includes(completionFile),
      `the message does not name ${completionFile}:\n${text}`,
    );
  });

  it("names the phrase completion folder that it could not open", async function () {
    const folder = path.join(homedir(), ".pandoc", "completions");
    const text = await refusedClick(
      PreferencesGroups.Snippets,
      "Snippets",
      "Open phrase completion dictionary",
    );
    assert.ok(text.includes(folder), `the message does not name ${folder}:\n${text}`);
  });
});

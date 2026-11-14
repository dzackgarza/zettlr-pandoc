/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a word that the disk refuses for the user dictionary
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The application writes the user dictionary (user.dic)
 *                  after each added word. Here a folder stands at the path
 *                  of user.dic, so the write fails. The author gets one
 *                  error window that names the file. When the path takes a
 *                  file again, the next added word writes the dictionary
 *                  with each word that the author added.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
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
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-user-dictionary-write-refused-e2e-latest");

/** The time in which a second error window of one write appears. */
const SECOND_WINDOW_MS = 3_000;

/** Each open error window of the application. */
async function errorWindows(browser: Browser): Promise<Page[]> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const counts = await Promise.all(pages.map(async (page) => await page.locator("#error").count()));
  return pages.filter((_page, index) => counts[index] > 0);
}

/** The words of the user dictionary file. */
async function wordsOnDisk(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter((word) => word.trim() !== "");
}

describe("a word that the disk refuses for the user dictionary", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let dictionaryFile = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-user-dictionary-write-refused-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    dictionaryFile = path.join(fixture.configDirectory, "user.dic");

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

  /** Adds a word to the user dictionary, as "Add to dictionary" does. */
  async function addWord(word: string): Promise<void> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const added = await editorPage.evaluate(
      async (term) =>
        await window.ipc.invoke("dictionary-provider", { command: "add", terms: [term] }),
      word,
    );
    assert.deepEqual(added, [true], `the application takes the word ${word}`);
  }

  it("names user.dic in one error window and saves the word with the next one", async function () {
    const running = requireInitialized(browser, "The application must be running");
    assert.deepEqual(
      await wordsOnDisk(dictionaryFile),
      ["Zettlr"],
      "the first start writes user.dic",
    );

    // A folder at the path of the file: the rename of the write fails.
    await rename(dictionaryFile, `${dictionaryFile}.moved`);
    await mkdir(dictionaryFile);
    await addWord("Coxeter");

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
    screenshots.set("user-dictionary-write-refused.png", await shown.screenshot());
    const text = await shown.locator("#error").innerText();
    assert.ok(
      text.includes(dictionaryFile),
      `the error window does not name ${dictionaryFile}:\n${text}`,
    );
    await clickToClose(shown, shown.getByRole("button", { name: "Ok" }));

    // The path takes a file again: the next word writes the whole dictionary.
    await rm(dictionaryFile, { recursive: true });
    await addWord("Vinberg");
    // The write renames a whole file into place, so a file that exists holds
    // a whole dictionary.
    const written = Date.now() + 10_000;
    let words: string[] = [];
    while (!words.includes("Vinberg")) {
      assert.ok(
        Date.now() < written,
        `user.dic does not hold the new word within 10 s: ${JSON.stringify(words)}`,
      );
      await delay(100);
      if (existsSync(dictionaryFile)) {
        words = await wordsOnDisk(dictionaryFile);
      }
    }
    assert.deepEqual(words, ["Zettlr", "Coxeter", "Vinberg"]);
  });
});

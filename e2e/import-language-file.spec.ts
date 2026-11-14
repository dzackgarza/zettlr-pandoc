/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of the language file import
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Import translation…" copies a PO file whose name is a
 *                  language tag into the language folder of the app, and the
 *                  app then lists that language. A file that the app does
 *                  not import is named in the window with the cause: a file
 *                  that is no PO file, a file whose name is no language tag,
 *                  and a file that the language folder refuses.
 *
 *                  The file dialog is a native window: the spec answers it
 *                  on the X display of the run (`support/native-dialog.ts`).
 *                  It opens in a folder of the fixture (`dialogPaths` of the
 *                  configuration).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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
import {
  captureWindow,
  nativeDialog,
  pressKey,
  searchWindows,
  typeText,
} from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-import-language-file-e2e-latest");
const FILE_DIALOG_TITLE = "Open file";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** A translation that the app ships, which the spec imports under other names. */
const TRANSLATION = path.join(process.cwd(), "static", "lang", "fr-FR.po");

describe("The language file import", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let sources = "";
  let languageFolder = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** Waits until no window has this title. */
  async function closed(title: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while ((await searchWindows(["--name", `^${title}$`])).length > 0) {
      assert.ok(Date.now() < deadline, `the dialog "${title}" closed`);
      await delay(250);
    }
  }

  /** The language tags that the app lists. */
  function availableLanguages(): Promise<string[]> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    return editorPage.evaluate(async () => {
      const languages: unknown = await window.ipc.invoke("application", {
        command: "get-available-languages",
      });
      if (!Array.isArray(languages)) {
        throw new Error("The application listed no languages");
      }
      return languages.map(String);
    });
  }

  /** Opens "Import translation…" and gives the window of its file dialog. */
  async function openImportDialog(): Promise<string> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.import_lang_file",
      });
    });
    return await nativeDialog(FILE_DIALOG_TITLE, 30_000);
  }

  /** Chooses one file of the sources folder in "Import translation…" by its path. */
  async function chooseLanguageFile(name: string): Promise<void> {
    const dialog = await openImportDialog();
    await pressKey(dialog, "ctrl+l");
    await typeText(dialog, name);
    screenshots.set(`dialog-${name}.png`, await captureWindow(dialog));
    await pressKey(dialog, "alt+o");
    await closed(FILE_DIALOG_TITLE);
  }

  /** Imports one file of the sources folder and gives the error toasts of the window. */
  async function refusedImport(name: string): Promise<string[]> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await chooseLanguageFile(name);
    const toast = editorPage.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 15_000 });
    screenshots.set(`refused-${name}.png`, await editorPage.screenshot());
    const texts = await toast.allInnerTexts();
    await editorPage.evaluate((selector) => {
      for (const shown of document.querySelectorAll(selector)) {
        shown.remove();
      }
    }, ERROR_TOAST);
    return texts;
  }

  before(async function () {
    const fixture = await createFixture("zettlr-import-language-file-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
    });
    fixtureRoot = fixture.root;
    sources = path.join(fixture.root, "translations");
    await mkdir(sources);
    await copyFile(TRANSLATION, path.join(sources, "fr-CA.po"));
    // The app reads translations from PO files only.
    await writeFile(path.join(sources, "de-DE.json"), '{ "language": "de-DE" }\n');
    languageFolder = path.join(fixture.configDirectory, "lang");
    await mkdir(languageFolder);

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    const refusal: unknown = await page.evaluate(
      (askFileDialog) =>
        window.ipc.sendSync("config-provider", {
          command: "set-config-single",
          payload: { key: "dialogPaths.askFileDialog", val: askFileDialog },
        }),
      sources,
    );
    assert.equal(refusal, null, "the file dialog opens in the folder of the translations");
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await chmod(languageFolder, 0o700);
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

  it("imports a PO file whose name is a language tag, and the app lists the language", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    assert.ok(!(await availableLanguages()).includes("fr-CA"), "the app has no fr-CA before");

    // The author chooses the file in the list of the dialog. The folder has
    // one PO file and one JSON file, and the list shows the files of the
    // filter of the dialog.
    const dialog = await openImportDialog();
    await delay(1_000);
    await pressKey(dialog, "End");
    screenshots.set("dialog-list.png", await captureWindow(dialog));
    await pressKey(dialog, "alt+o");
    await closed(FILE_DIALOG_TITLE);

    const deadline = Date.now() + 15_000;
    while (!(await readdir(languageFolder)).includes("fr-CA.po")) {
      assert.ok(Date.now() < deadline, "the language folder has the file before the time limit");
      await delay(250);
    }
    assert.ok((await availableLanguages()).includes("fr-CA"), "the app lists the language");
    assert.equal(await editorPage.locator(ERROR_TOAST).count(), 0, "the import shows no error");
  });

  it("names a file that is no PO file", async function () {
    const toasts = await refusedImport("de-DE.json");

    assert.equal(toasts.length, 1, "one refused file shows one message");
    assert.ok(toasts[0].includes("de-DE.json"), "the message names the file");
    assert.deepEqual(await readdir(languageFolder), ["fr-CA.po"], "the folder has no new file");
  });

  it("names a file whose name is no language tag", async function () {
    // A POSIX locale name is no language tag.
    await copyFile(TRANSLATION, path.join(sources, "de_DE.po"));
    const toasts = await refusedImport("de_DE.po");

    assert.equal(toasts.length, 1, "one refused file shows one message");
    assert.ok(toasts[0].includes("de_DE.po"), "the message names the file");
    assert.deepEqual(await readdir(languageFolder), ["fr-CA.po"], "the folder has no new file");
  });

  it("names a file that the language folder refuses", async function () {
    await copyFile(TRANSLATION, path.join(sources, "fr-BE.po"));
    await chmod(languageFolder, 0o500);

    const toasts = await refusedImport("fr-BE.po");

    assert.equal(toasts.length, 1, "one refused file shows one message");
    assert.ok(toasts[0].includes("fr-BE.po"), "the message names the file");
    assert.ok(toasts[0].includes(languageFolder), "the message names the folder that refused it");
  });
});

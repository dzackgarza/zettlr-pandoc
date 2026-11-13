/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of the file import
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     File → "Import files…" asks the author for a folder and
 *                  for files, and puts the files into the folder. An import
 *                  replaces no file of the folder: a file whose name the
 *                  folder has already is refused, the window names it with
 *                  the cause, and the note of the author keeps its text.
 *
 *                  The two dialogs are native windows: the spec finds and
 *                  answers them on the X display of the run
 *                  (`support/native-dialog.ts`). Each dialog opens in a
 *                  folder of the fixture (`dialogPaths` of the configuration),
 *                  so no dialog shows a folder of the author.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-import-files-e2e-latest");
/** The text of the note that the author wrote in the import folder. */
const AUTHORED = "# Genus\n\nTwo forms of one genus.\n";
/** The text of a note that an import brings. */
const INCOMING = "# Spinor genus\n\nA form of one spinor genus.\n";
const FOLDER_DIALOG_TITLE = "Import directory";
const FILE_DIALOG_TITLE = "Open file";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

describe("an import of files into a folder of the author", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let workspace = "";
  let sources = "";
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

  /**
   * Accepts the folder that the folder dialog shows. The dialog opens in the
   * workspace; the mnemonic of its Open button accepts that folder.
   */
  async function chooseShownFolder(capture: string): Promise<void> {
    const dialog = await nativeDialog(FOLDER_DIALOG_TITLE, 30_000);
    screenshots.set(capture, await captureWindow(dialog));
    await pressKey(dialog, "alt+o");
    await closed(FOLDER_DIALOG_TITLE);
  }

  /**
   * Chooses one file of the folder that the file dialog shows: Ctrl+L puts
   * the focus into the location field, and the mnemonic of the Open button
   * accepts the name that the field has. The Return key does not accept it
   * while the location field has the focus.
   */
  async function chooseFile(name: string, capture: string): Promise<void> {
    const dialog = await nativeDialog(FILE_DIALOG_TITLE, 30_000);
    await pressKey(dialog, "ctrl+l");
    await typeText(dialog, name);
    screenshots.set(capture, await captureWindow(dialog));
    await pressKey(dialog, "alt+o");
    await closed(FILE_DIALOG_TITLE);
  }

  /** Runs the import command for one file of the sources directory. */
  async function importFile(name: string): Promise<void> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.import_files",
      });
    });
    await chooseShownFolder(`folder-dialog-${name}.png`);
    await chooseFile(name, `file-dialog-${name}.png`);
  }

  before(async function () {
    const fixture = await createFixture("zettlr-import-files-e2e-", {
      documentName: "genus.md",
      documentContents: AUTHORED,
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    workspace = path.dirname(fixture.documentPath);
    sources = path.join(fixture.root, "sources");
    await mkdir(sources);
    await writeFile(path.join(sources, "genus.md"), INCOMING);
    await writeFile(path.join(sources, "spinor.md"), INCOMING);
    const configFile = path.join(fixture.configDirectory, "config.json");
    const stored: unknown = JSON.parse(await readFile(configFile, "utf8"));
    assert.ok(stored !== null && typeof stored === "object", "the fixture has a configuration");
    await writeFile(
      configFile,
      `${JSON.stringify(
        { ...stored, dialogPaths: { askDirDialog: workspace, askFileDialog: sources } },
        null,
        2,
      )}\n`,
    );
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

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
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  it("puts a file with a new name into the folder", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const imported = path.join(workspace, "spinor.md");

    await importFile("spinor.md");

    await editorPage
      .locator(`#file-manager .tree-item[data-path="${imported}"]`)
      .waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("imported.png", await editorPage.screenshot());
    assert.equal(await readFile(imported, "utf8"), INCOMING, "the folder has the imported text");
    assert.equal(await editorPage.locator(ERROR_TOAST).count(), 0, "the window shows no error");
  });

  it("keeps a note of the folder and names the file that it did not import", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");

    await importFile("genus.md");

    // The import ends with a message or with a changed note: the wait ends
    // at the first of the two, and the note is checked before the message.
    const toast = editorPage.locator(ERROR_TOAST);
    const deadline = Date.now() + 30_000;
    while ((await toast.count()) === 0 && (await readFile(documentPath, "utf8")) === AUTHORED) {
      assert.ok(Date.now() < deadline, "the import ends with a message or a changed note");
      await delay(100);
    }
    screenshots.set("refused.png", await editorPage.screenshot());
    assert.equal(await readFile(documentPath, "utf8"), AUTHORED, "the note keeps its text");
    assert.equal(await toast.count(), 1, "one refused import shows one message");
    assert.equal(
      await toast.first().locator("span:first-child").innerText(),
      "Could not import genus.md: genus.md exists already in the import folder.",
    );
  });
});

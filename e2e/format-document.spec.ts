/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: the format of a document in the window
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: Flowmark formats a document on a key and, with the setting,
 *              on each save. The spec runs the real formatter: the key gives
 *              the editor the formatted text as one step that Undo takes
 *              back and writes no file; a save with the setting writes the
 *              formatted text. A format that does not finish in its time
 *              shows its cause, leaves the text as it is, and the save still
 *              writes the text of the author (#47, rows 47.5.a and 47.5.b).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditorView } from "@codemirror/view";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  readAppLog,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-format-document-e2e-latest");

/** A document with runs of spaces, two sentences on one line, and wide list markers. */
const UNFORMATTED = [
  "# Lattices",
  "",
  "An even unimodular lattice has a rank that 8 divides.   The   E8 lattice is the one of rank 8. There are two of rank 16.",
  "",
  "*   a list item",
  "*   another item",
  "",
].join("\n");
/**
 * What Flowmark makes of it with the options of the app (`--semantic`): a
 * line break after the first sentence, one space between words, and a blank
 * line between the items of the list. The text is written by hand from a run
 * of the formatter.
 */
const FORMATTED = [
  "# Lattices",
  "",
  "An even unimodular lattice has a rank that 8 divides.",
  "The E8 lattice is the one of rank 8. There are two of rank 16.",
  "",
  "* a list item",
  "",
  "* another item",
  "",
].join("\n");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

/** The text of the editor. */
async function editorText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
    if (view === undefined) {
      throw new Error("the production editor exposes no CodeMirror view");
    }
    return view.state.doc.toString();
  });
}

/** Waits until the editor has a text, and gives the text that it has at the end. */
async function editorTextOnceItIs(page: Page, expected: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let text = await editorText(page);
  while (text !== expected && Date.now() < deadline) {
    await delay(100);
    text = await editorText(page);
  }
  return text;
}

/** Waits until a file has a text, and gives the text that it has at the end. */
async function fileTextOnceItIs(file: string, expected: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let text = await readFile(file, "utf8");
  while (text !== expected && Date.now() < deadline) {
    await delay(100);
    text = await readFile(file, "utf8");
  }
  return text;
}

/** Saves the active document as the Save item of the File menu does. */
async function saveFromMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
  });
}

describe("assembled app: the format of a document (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-format-document-e2e-", {
      documentName: "lattices.md",
      documentContents: UNFORMATTED,
      config: { darkMode: false, editor: { autoSave: "off", formatOnSave: false } },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
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

  it("gives the editor the formatted text on the key, and writes no file", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(".cm-content").click();

    await activePage.keyboard.press("Control+Alt+l");

    assert.equal(await editorTextOnceItIs(activePage, FORMATTED), FORMATTED);
    screenshots.set("formatted.png", await activePage.screenshot());
    assert.equal(
      await readFile(documentPath, "utf8"),
      UNFORMATTED,
      "the format changes the text of the editor, and the file keeps its text",
    );
    assert.equal(
      await activePage.locator('.editor-pane [role="tab"].modified').count(),
      1,
      "the tab shows unsaved text",
    );
    assert.equal(await activePage.locator(ERROR_TOAST).count(), 0, "no error is shown");
  });

  it("takes the format back with one Undo", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(".cm-content").click();

    await activePage.keyboard.press("Control+z");

    assert.equal(
      await editorTextOnceItIs(activePage, UNFORMATTED),
      UNFORMATTED,
      "one Undo gives the text from before the format, byte for byte",
    );
  });

  it("writes the formatted text on a save with the setting", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The write of the Preferences for the setting "format on save".
    const refusal = await activePage.evaluate(() =>
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: { key: "editor.formatOnSave", val: true },
      }),
    );
    assert.equal(refusal, null, "the setting is saved");
    await activePage.locator(".cm-content").click();

    await saveFromMenu(activePage);

    assert.equal(await fileTextOnceItIs(documentPath, FORMATTED), FORMATTED);
    assert.equal(await editorTextOnceItIs(activePage, FORMATTED), FORMATTED);
    await activePage
      .locator('.editor-pane [role="tab"].modified')
      .waitFor({ state: "detached", timeout: 20_000 });
  });
});

describe("assembled app: a format that does not finish in its time (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-format-timeout-e2e-", {
      documentName: "lattices.md",
      documentContents: UNFORMATTED,
      // One millisecond: the formatter does not start in that time.
      config: {
        darkMode: false,
        editor: { autoSave: "off", formatOnSave: true, formatTimeoutMs: 1 },
      },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
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
      path.join(tmpdir(), "zettlr-format-timeout-e2e-latest"),
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assertCleanExit(getOutput());
  });

  it("shows the cause on the key and leaves the text as it is", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(".cm-content").click();

    await activePage.keyboard.press("Control+Alt+l");

    const toast = activePage.locator(ERROR_TOAST).first();
    await toast.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("format-timeout.png", await activePage.screenshot());
    const message = await toast.innerText();
    assert.ok(
      message.includes("Couldn't format the document:"),
      `the window says that the document was not formatted: ${message}`,
    );
    assert.equal(await editorText(activePage), UNFORMATTED, "the editor keeps its text");
    assert.equal(await readFile(documentPath, "utf8"), UNFORMATTED, "the file keeps its text");
    // The log file of the app keeps the failure of the subprocess.
    assert.ok(
      (await readAppLog(requireInitialized(fixtureRoot, "the fixture exists"))).includes(
        "flowmark did not end within 1 ms",
      ),
      "the app log has the cause of the failed format",
    );
    assert.equal(
      await activePage.locator('.editor-pane [role="tab"].modified').count(),
      0,
      "no tab shows unsaved text",
    );
  });

  it("writes the text of the author on a save whose format did not finish", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The author adds a line at the end of the document.
    await activePage.locator(".cm-content").click();
    await activePage.keyboard.press("Control+End");
    await activePage.keyboard.type("A new line of the author.");
    const typed = `${UNFORMATTED}A new line of the author.`;
    assert.equal(await editorText(activePage), typed);

    await saveFromMenu(activePage);

    assert.equal(
      await fileTextOnceItIs(documentPath, typed),
      typed,
      "the save writes the text of the editor, which no format changed",
    );
    assert.equal(await editorText(activePage), typed, "the editor keeps the text of the author");
  });
});

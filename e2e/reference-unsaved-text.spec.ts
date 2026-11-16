/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: workspace references against closed files and unsaved text
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: The references of the workspace come from the files on disk
 *              and from the text of each open document, saved or not. The
 *              spec reads them where an author does: the count on the badge
 *              of a label, the list of its citing locations, the completion,
 *              the key that follows a link, and the reference search of the
 *              launcher. It types a reference and a label without a save,
 *              then saves, quits and starts the app again (#47, rows 47.3.e,
 *              47.4.d and 47.4.e).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-reference-unsaved-text-e2e-latest");
const LAUNCHER = "[data-command-launcher]";

/** The open document: it defines the label. */
const FORMS = "# Forms {#sec:forms}\n\nA form is even when each of its values is even.\n";
/** A file that no pane shows: it cites the label two times. */
const USES = "See @sec:forms for the definition, and @sec:forms again.\n";

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

describe("assembled app: workspace references against closed files and unsaved text (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let formsPath = "";
  let usesPath = "";
  let getOutput: () => string = () => "";
  const outputs: string[] = [];
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** The text of the editor and the line of its cursor, from 1. */
  async function editorState(activePage: Page): Promise<{ text: string; cursorLine: number }> {
    return await activePage.evaluate(() => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) {
        throw new Error("the production editor exposes no CodeMirror view");
      }
      return {
        text: view.state.doc.toString(),
        cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number,
      };
    });
  }

  /** The count that the badge of a label shows, once it is the expected one. */
  async function citingCount(activePage: Page, key: string, expected: number): Promise<string> {
    const badge = activePage.locator(`.reference-count-badge[data-reference-key="${key}"]`);
    await badge.first().waitFor({ state: "attached", timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    let shown = await badge.first().getAttribute("data-citing-count");
    while (shown !== String(expected) && Date.now() < deadline) {
      await delay(200);
      shown = await badge.first().getAttribute("data-citing-count");
    }
    return `${shown}: ${(await badge.first().innerText()).trim()}`;
  }

  /** Types a text at the end of the document, as an author does. */
  async function typeAtEnd(activePage: Page, text: string): Promise<void> {
    await activePage.locator(".cm-content").click({ position: { x: 4, y: 4 } });
    await activePage.keyboard.press("Control+End");
    // The text arrives as one insertion, as a paste does: the editor closes
    // a brace that an author types, which is no part of this journey.
    await activePage.keyboard.insertText(text);
  }

  before(async function () {
    const fixture = await createFixture("zettlr-reference-unsaved-text-e2e-", {
      documentName: "forms.md",
      documentContents: FORMS,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    formsPath = fixture.documentPath;
    usesPath = path.join(path.dirname(formsPath), "uses.md");
    await writeFile(usesPath, USES, "utf8");

    const app = await attach(configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    outputs.push(getOutput());
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      outputs.join("\n== next start\n"),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    for (const output of outputs) {
      assertCleanExit(output);
    }
  });

  it("counts on the badge of a label the references of a file that no pane shows", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    assert.equal(await citingCount(activePage, "sec:forms", 2), "2: 2 references");
  });

  it("counts a reference that the author typed and did not save", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    await typeAtEnd(activePage, "\nThe rank of @sec:forms is its dimension.\n");

    assert.equal(await citingCount(activePage, "sec:forms", 3), "3: 3 references");
    assert.equal(await readFile(formsPath, "utf8"), FORMS, "the file has no typed text");
  });

  it("lists the citing locations of the closed file and of the unsaved text on a click on the badge", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    await activePage.locator('.reference-count-badge[data-reference-key="sec:forms"]').click();

    const view = activePage.locator('.reference-search-view[data-search-mode="citing-locations"]');
    await view.waitFor({ state: "visible", timeout: 20_000 });
    const rows = view.locator(".reference-row[data-occurrence-path]");
    await rows.nth(2).waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("citing-locations.png", await activePage.screenshot());
    assert.deepEqual(
      (
        await rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-occurrence-path")),
        )
      ).sort(),
      [formsPath, usesPath, usesPath].sort(),
      "two locations of the closed file and one of the unsaved text",
    );
    await activePage.keyboard.press("Escape");
    await activePage.locator(LAUNCHER).waitFor({ state: "detached", timeout: 10_000 });
  });

  it("completes a label that the author typed and did not save", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await typeAtEnd(activePage, "\n## Ranks {#sec:ranks}\n\nRefer:");
    // The references of the unsaved text reach the editor after a pause.
    await citingCount(activePage, "sec:ranks", 0);

    await activePage.keyboard.type(" @sec:ra", { delay: 30 });
    await activePage.keyboard.press("Control+Space");
    const popup = activePage.locator(".cm-tooltip-autocomplete");
    await popup.waitFor({ state: "visible", timeout: 20_000 });
    // The editor takes no choice in the first 75 ms of a list.
    await activePage.waitForTimeout(300);
    await popup.locator("li", { hasText: "sec:ranks" }).click();

    const deadline = Date.now() + 20_000;
    while (
      !(await editorState(activePage)).text.includes("Refer: @sec:ranks") &&
      Date.now() < deadline
    ) {
      await delay(100);
    }
    assert.ok((await editorState(activePage)).text.endsWith("Refer: @sec:ranks"));
    assert.equal(await citingCount(activePage, "sec:ranks", 1), "1: 1 reference");
  });

  it("follows the reference to the label of the unsaved text with the key of Follow link", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The caret is at the end of the reference that the completion wrote.
    await activePage.keyboard.press("ArrowLeft");

    await activePage.keyboard.press("F12");

    const { text } = await editorState(activePage);
    const labelLine = text.split("\n").indexOf("## Ranks {#sec:ranks}") + 1;
    assert.ok(labelLine > 0, "the editor has the heading of the label");
    const deadline = Date.now() + 10_000;
    while ((await editorState(activePage)).cursorLine !== labelLine && Date.now() < deadline) {
      await delay(100);
    }
    assert.equal((await editorState(activePage)).cursorLine, labelLine);
  });

  it("finds the label of the unsaved text in the reference search of the launcher", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    await activePage.evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.command_launcher",
      });
    });
    await activePage
      .locator(`${LAUNCHER} [data-launcher-row]`, { hasText: "Search references" })
      .first()
      .click();
    const row = activePage.locator('.reference-row[data-reference-key="sec:ranks"]');
    await row.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await row.getAttribute("data-reference-path"), formsPath);
    screenshots.set("reference-search.png", await activePage.screenshot());
    await activePage.keyboard.press("Escape");
    await activePage.keyboard.press("Escape");
    await activePage.locator(LAUNCHER).waitFor({ state: "detached", timeout: 10_000 });
  });

  it("has each label and each count after a save, a quit and a new start", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
    });
    await activePage
      .locator('.editor-pane [role="tab"].modified')
      .waitFor({ state: "detached", timeout: 20_000 });
    const saved = await readFile(formsPath, "utf8");
    assert.ok(saved.includes("## Ranks {#sec:ranks}"), "the file has the typed label");

    await shutdown(browser, appProcess);
    outputs.push(getOutput());
    // The quit writes what the app knows of each file to its cache.
    assert.ok(
      (await readAppLog(requireInitialized(fixtureRoot, "the fixture exists"))).includes(
        "[FSAL Cache]",
      ),
      "the app log has the write of the cache at the quit",
    );
    const app = await attach(configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });

    assert.equal(await citingCount(page, "sec:forms", 3), "3: 3 references");
    assert.equal(await citingCount(page, "sec:ranks", 1), "1: 1 reference");
    assert.equal((await editorState(page)).text, saved, "the editor has the saved text");
  });
});

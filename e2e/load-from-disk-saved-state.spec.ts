/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: the saved state of a document after a load from disk
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: "Load from disk" gives the editor the text of the file and
 *              drops the text that the author did not save. The document
 *              then has no unsaved text, and its tab says so: the mark of
 *              unsaved text is gone.
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
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-load-from-disk-saved-state-e2e-latest");
const NOTE = "# Lattices\n\nA lattice is unimodular when its discriminant is a unit.\n";
const MODIFIED_TAB = '.editor-pane [role="tab"].modified';

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

describe("assembled app: the saved state of a document after a load from disk", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notePath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** The text of the editor. */
  async function editorText(activePage: Page): Promise<string> {
    return await activePage.evaluate(() => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) {
        throw new Error("the production editor exposes no CodeMirror view");
      }
      return view.state.doc.toString();
    });
  }

  before(async function () {
    const fixture = await createFixture("zettlr-load-from-disk-saved-state-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    notePath = fixture.documentPath;
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

  it("takes the mark of unsaved text off the tab", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(".cm-content").click();
    await activePage.keyboard.press("Control+End");
    await activePage.keyboard.type("A line that the author does not save.");
    await activePage.locator(MODIFIED_TAB).waitFor({ state: "visible", timeout: 10_000 });

    // The call that the action "Load from disk" of a message makes.
    await activePage.evaluate(
      async (pathInPage) =>
        await window.ipc.invoke("documents-provider", {
          command: "load-from-disk",
          payload: { path: pathInPage },
        }),
      notePath,
    );

    const deadline = Date.now() + 10_000;
    while ((await editorText(activePage)) !== NOTE && Date.now() < deadline) {
      await delay(100);
    }
    assert.equal(await editorText(activePage), NOTE, "the editor has the text of the file");
    assert.equal(await readFile(notePath, "utf8"), NOTE, "the file keeps its text");
    assert.deepEqual(
      await activePage.evaluate(
        async () =>
          await window.ipc.invoke("documents-provider", {
            command: "get-file-modification-status",
          }),
      ),
      [],
      "no document has unsaved text",
    );
    await activePage.locator(MODIFIED_TAB).waitFor({ state: "detached", timeout: 10_000 });
    screenshots.set("loaded-from-disk.png", await activePage.screenshot());
  });
});

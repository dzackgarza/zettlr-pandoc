/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: completions and Project status of references in the window
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: An author types `@` and chooses a citation of the library or a
 *              label of the workspace. A label of a file that the Project
 *              does not list is "Not included in current Project": the hover
 *              of a reference to it says so, and a completion of it adds its
 *              file to the Project. The spec types each completion on the
 *              keyboard and chooses from the list of the editor (#47, rows
 *              47.3.a and 47.3.d).
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
import { hoverText } from "./support/editor-hover";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-reference-completion-e2e-latest");

const LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  journal = {Math. USSR Izv.},
  year = {1980}
}
`;
const NOTE = [
  "# Lattices",
  "",
  "Known: @def:omitted-genus is the definition of another file.",
  "",
  "Cite:",
  "",
  "Refer:",
  "",
  "Define:",
  "",
].join("\n");
/** A file of the Project. */
const LISTED = [
  "# Listed",
  "",
  '::: {.theorem #thm:in-project title="Unimodular lattices"}',
  "An even unimodular lattice has a rank that 8 divides.",
  ":::",
  "",
].join("\n");
/** A file of the folder that the Project does not list. */
const OMITTED = [
  "# Omitted",
  "",
  '::: {.definition #def:omitted-genus title="Genus"}',
  "Two lattices are in one genus when they are isometric over each completion.",
  ":::",
  "",
].join("\n");
const PROJECT_FILES = ["note.md", "listed.md"];
const PROJECT_SETTINGS = {
  sorting: "name-up",
  project: {
    title: "Lattice notes",
    profiles: [],
    files: PROJECT_FILES,
    cslStyle: "",
    templates: { tex: "", html: "" },
  },
  icon: null,
  color: null,
};
const STATUS = ".reference-hover-preview [data-reference-project-status]";

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

describe("assembled app: completions and Project status of references (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notePath = "";
  let settingsFile = "";
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

  /** Takes the pointer off the text and waits until no hover is open. */
  async function closeHover(activePage: Page): Promise<void> {
    await activePage.mouse.move(5, 5);
    await activePage.locator(".cm-tooltip-hover").waitFor({ state: "detached", timeout: 20_000 });
  }

  /**
   * Types a text at the end of the line that starts with `lineStart`, as an
   * author does, and gives the list of completions that the editor shows.
   */
  async function typeAtEndOfLine(activePage: Page, lineStart: string, text: string) {
    await closeHover(activePage);
    await activePage.locator(".cm-content .cm-line", { hasText: lineStart }).first().click();
    await activePage.keyboard.press("End");
    await activePage.keyboard.type(` ${text}`, { delay: 30 });
    // The key of the editor that opens the list at the caret.
    await activePage.keyboard.press("Control+Space");
    const popup = activePage.locator(".cm-tooltip-autocomplete");
    await popup.waitFor({ state: "visible", timeout: 20_000 });
    // The editor takes no choice in the first 75 ms of a list
    // (`interactionDelay` of CodeMirror), so that a key that an author typed
    // before the list opened chooses nothing. An author chooses later.
    await activePage.waitForTimeout(300);
    return popup;
  }

  /** Waits until the text of the editor has a part. */
  async function waitForText(activePage: Page, part: string): Promise<void> {
    await activePage.waitForFunction(
      (expected) =>
        document
          .querySelector<EditorContentElement>(".cm-content")
          ?.cmTile?.root.view.state.doc.toString()
          .includes(expected) === true,
      part,
      { timeout: 20_000 },
    );
  }

  /** The Project status that the hover of a reference shows. */
  async function hoverStatus(activePage: Page, reference: string) {
    await closeHover(activePage);
    await hoverText(activePage, reference);
    const status = activePage.locator(STATUS);
    await status.waitFor({ state: "visible", timeout: 20_000 });
    return {
      status: await status.getAttribute("data-reference-project-status"),
      wording: await status.innerText(),
    };
  }

  before(async function () {
    const fixture = await createFixture("zettlr-reference-completion-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      // Source text, so that the hover target is the authored reference.
      config: { darkMode: false, editor: { autoSave: "off" }, display: { renderingMode: "raw" } },
    });
    fixtureRoot = fixture.root;
    notePath = fixture.documentPath;
    const workspace = path.dirname(notePath);
    settingsFile = path.join(workspace, ".ztr-directory");
    await writeFile(settingsFile, JSON.stringify(PROJECT_SETTINGS), "utf8");
    await writeFile(path.join(workspace, "listed.md"), LISTED, "utf8");
    await writeFile(path.join(workspace, "omitted.md"), OMITTED, "utf8");
    const libraryPath = path.join(fixture.root, "references.bib");
    await writeFile(libraryPath, LIBRARY, "utf8");
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.export = { ...(config.export as Record<string, unknown>), cslLibrary: libraryPath };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

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

  it("says in the hover that a label of an unlisted file is not included in the Project", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    const shown = await hoverStatus(activePage, "@def:omitted-genus");

    screenshots.set("hover-omitted.png", await activePage.screenshot());
    assert.deepEqual(shown, {
      status: "omitted-from-active-project",
      wording: "Not included in current Project",
    });
  });

  it("completes a citation of the library", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    const popup = await typeAtEndOfLine(activePage, "Cite:", "@Nik");
    const entry = popup.locator("li", { hasText: "Nik80" });
    await entry.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("completion-citation.png", await activePage.screenshot());
    await entry.click();

    // A citation is inserted in its brackets; a label is inserted bare.
    await waitForText(activePage, "Cite: [@Nik80]");
  });

  it("completes a label of a file of the Project, and changes no setting of the Project", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    const popup = await typeAtEndOfLine(activePage, "Refer:", "@thm");
    const entry = popup.locator("li", { hasText: "thm:in-project" });
    await entry.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("completion-label.png", await activePage.screenshot());
    await entry.click();

    await waitForText(activePage, "Refer: @thm:in-project");
    assert.deepEqual(
      JSON.parse(await readFile(settingsFile, "utf8")).project.files,
      PROJECT_FILES,
      "the Project lists the files that it listed",
    );
    assert.deepEqual(await hoverStatus(activePage, "@thm:in-project"), {
      status: "in-active-project",
      wording: "In current Project",
    });
  });

  it("adds the file of a label to the Project when the author completes a label of an unlisted file", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    const popup = await typeAtEndOfLine(activePage, "Define:", "@def");
    const entry = popup.locator("li", { hasText: "def:omitted-genus" });
    await entry.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("completion-omitted.png", await activePage.screenshot());
    await entry.click();

    await waitForText(activePage, "Define: @def:omitted-genus");
    // The completion adds the file of the label to the files of the Project.
    const deadline = Date.now() + 20_000;
    let files: unknown = JSON.parse(await readFile(settingsFile, "utf8")).project.files;
    while (JSON.stringify(files) !== JSON.stringify([...PROJECT_FILES, "omitted.md"])) {
      assert.ok(Date.now() < deadline, `the Project lists the file: ${JSON.stringify(files)}`);
      await activePage.waitForTimeout(200);
      files = JSON.parse(await readFile(settingsFile, "utf8")).project.files;
    }
    assert.deepEqual(await hoverStatus(activePage, "@def:omitted-genus"), {
      status: "in-active-project",
      wording: "In current Project",
    });

    // The completions changed the document; the author saves it, so the app
    // quits without a prompt. This is the IPC call that the save-file
    // shortcut makes: CDP key events do not reach the shortcut.
    await activePage.evaluate(
      async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
      notePath,
    );
    assert.equal(
      await readFile(notePath, "utf8"),
      await editorText(activePage),
      "the file has the text of the editor",
    );
  });
});

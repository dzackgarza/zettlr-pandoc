/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: a wikilink to a heading of a document that is not open
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: `[[file#heading]]` opens the file with the cursor on the
 *              heading. The window gets the line when the tab of the file
 *              exists; the editor of the tab gets the text of the file
 *              later. The spec follows links to the last heading of a long
 *              document, by a Mod-click on the chip and by the key of
 *              "Follow link", and each time the cursor is on that heading:
 *              a line that arrives before the text is kept until the text
 *              is there.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-jump-to-heading-while-loading-e2e-latest");
const INDEX = [
  "# Index",
  "",
  "By the chip: [[long-genus#Last section|the end of the genus]]",
  "",
  "By the key: [[long-rank#Last section|the end of the rank]]",
  "",
].join("\n");
const HEADING = "# Last section";
/**
 * The lines of a long document. The editor takes longer to get this text
 * than the window waits before it sends the line of the heading.
 */
const LINES = 15_000;

/** A document of LINES lines whose last heading is `HEADING`. */
function longDocument(title: string): string {
  const lines = [`# ${title}`, ""];
  for (let line = 1; line <= LINES; line += 1) {
    lines.push(`Line ${line} of the document ${title}.`);
  }
  lines.push("", HEADING, "", "The end.", "");
  return lines.join("\n");
}

/** The element of an editor, with the CodeMirror view that it carries. */
interface EditorContent extends HTMLElement {
  cmTile?: { root?: { view?: EditorView } };
}

interface EditorState {
  text: string;
  cursorLine: number;
}

/** The text and the line of the cursor of each editor of the window. */
async function editorStates(page: Page): Promise<EditorState[]> {
  return await page.evaluate(() => {
    const states: Array<{ text: string; cursorLine: number }> = [];
    for (const content of document.querySelectorAll<EditorContent>(".cm-content")) {
      const view = content.cmTile?.root?.view;
      if (view !== undefined) {
        states.push({
          text: view.state.doc.toString(),
          cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        });
      }
    }
    return states;
  });
}

describe("assembled app: a wikilink to a heading of a document that is not open", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const texts = new Map<string, string>();
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** Waits until an editor shows the document with the cursor on its last heading. */
  async function assertCursorOnLastHeading(activePage: Page, name: string): Promise<void> {
    const text = requireInitialized(texts.get(name), `the fixture has ${name}`);
    const headingLine = text.split("\n").indexOf(HEADING) + 1;
    const deadline = Date.now() + 30_000;
    let shown: EditorState | undefined;
    while (shown === undefined && Date.now() < deadline) {
      shown = (await editorStates(activePage)).find((state) => state.text === text);
      if (shown === undefined) {
        await delay(50);
      }
    }
    assert.ok(shown !== undefined, `an editor shows ${name}`);
    // The window sends the line when its list of panes has the document,
    // which can be after the editor has the text: the window asks the main
    // process for that list, and tries again each 100 ms until the list has
    // it. The wait is for the cursor on the heading, with no set time for
    // the arrival of the line. A jump that is lost leaves the cursor on line
    // 1 until the limit.
    const cursorLine = async (): Promise<number | undefined> =>
      (await editorStates(activePage)).find((state) => state.text === text)?.cursorLine;
    while ((await cursorLine()) !== headingLine && Date.now() < deadline) {
      await delay(50);
    }
    assert.equal(
      await cursorLine(),
      headingLine,
      `the cursor of ${name} is on "${HEADING}", line ${headingLine}`,
    );
    // Nothing moves the cursor afterwards: a load that ends later keeps it.
    await delay(1_000);
    assert.equal(
      await cursorLine(),
      headingLine,
      `the cursor of ${name} stays on "${HEADING}", line ${headingLine}`,
    );
  }

  before(async function () {
    const fixture = await createFixture("zettlr-jump-to-heading-while-loading-e2e-", {
      documentName: "index.md",
      documentContents: INDEX,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    const workspace = path.dirname(fixture.documentPath);
    for (const name of ["long-genus.md", "long-rank.md"]) {
      const text = longDocument(name);
      texts.set(name, text);
      await writeFile(path.join(workspace, name), text, "utf8");
    }

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    // The links are chips when the main process resolved their targets.
    await page.locator(".wikilink-chip").nth(1).waitFor({ state: "visible", timeout: 30_000 });
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

  it("puts the cursor on the heading after a Mod-click on the chip of the link", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");

    await activePage
      .locator(".wikilink-chip", { hasText: "the end of the genus" })
      .click({ modifiers: ["Control"] });

    await assertCursorOnLastHeading(activePage, "long-genus.md");
    screenshots.set("after-mod-click.png", await activePage.screenshot());
  });

  it("puts the cursor on the heading after the key of Follow link", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator('.editor-pane [role="tab"]', { hasText: "Index" }).first().click();
    // The caret on the line of the link shows its source; the caret goes
    // into the link.
    await activePage.locator(".cm-line", { hasText: "By the key:" }).click();
    await activePage.keyboard.press("End");
    await activePage.keyboard.press("ArrowLeft");
    await activePage.keyboard.press("ArrowLeft");
    await activePage.keyboard.press("ArrowLeft");

    await activePage.keyboard.press("F12");

    await assertCursorOnLastHeading(activePage, "long-rank.md");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Shift-click on a rendered widget
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A click in the text puts the anchor of the selection there.
 *                  A Shift-click on a rendered widget (an equation, a wikilink
 *                  chip) extends the selection from that anchor over the whole
 *                  source of the widget, in either direction (#181).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type EditorView } from "@codemirror/view";
import type { Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  type RunningApp,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-shift-click-widgets-e2e-latest");

const EQUATION = "$x^2 + y^2$";
const LINK = "[[curves]]";
const TASK = "[ ]";
const DOCUMENT = [
  "# Shift",
  "",
  `Start here with the equation ${EQUATION} and the link ${LINK} to the end.`,
  "",
  "Outside probe.",
  "",
  `- ${TASK} Check the fibers.`,
  "",
].join("\n");

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

interface Selection {
  anchor: number;
  head: number;
}

async function selection(page: Page): Promise<Selection> {
  return await page.evaluate(() => {
    const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
    if (view === undefined) throw new Error("No CodeMirror view is mounted");
    return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
  });
}

/** The point of the character at a document position, in the source text. */
async function pointOfCharacter(page: Page, position: number): Promise<{ x: number; y: number }> {
  return await page.evaluate((at) => {
    const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
    if (view === undefined) throw new Error("No CodeMirror view is mounted");
    const start = view.coordsAtPos(at, 1);
    const end = view.coordsAtPos(at + 1, -1);
    if (start === null || end === null) throw new Error(`No layout at ${at}`);
    return { x: (start.left + end.left) / 2, y: (start.top + start.bottom) / 2 };
  }, position);
}

/** The centre of the rendered widget whose source starts at a position. */
async function widgetCentre(page: Page, from: number): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const centre = await page.evaluate((start) => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) throw new Error("No CodeMirror view is mounted");
      const widget = Array.from(
        view.contentDOM.querySelectorAll<HTMLElement>("[data-preview-source-length]"),
      ).find((element) => view.posAtDOM(element) === start);
      if (widget === undefined) return null;
      const rect = widget.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, from);
    if (centre !== null) {
      return centre;
    }
    await delay(100);
  }
  throw new Error(`No rendered widget starts at ${from}`);
}

describe("assembled editor: Shift-click on a rendered widget extends the selection", function () {
  this.timeout(300_000);

  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let page: Page | undefined;
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-shift-click-widgets-e2e-", {
      documentName: "shift.md",
      documentContents: DOCUMENT,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    await writeFile(path.join(path.dirname(fixture.documentPath), "curves.md"), "# Curves\n");
    app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    page = await findEditorPage(app.browser, 60_000);
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: 60_000 });
  });

  after(async function () {
    let output = "";
    if (app !== undefined) {
      await shutdown(app.browser, app.appProcess);
      output = app.getOutput();
    }
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixtureRoot, output, rendererEvents, screenshots);
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assertCleanExit(output);
  });

  /** Click the character at `anchor`, then Shift-click the widget at `widgetFrom`. */
  async function extendToWidget(anchor: number, widgetFrom: number): Promise<Selection> {
    const editor = requireInitialized(page, "editor page");
    await editor.locator(".cm-line", { hasText: "Outside probe." }).click();
    await delay(600);
    const start = await pointOfCharacter(editor, anchor);
    await editor.mouse.click(start.x, start.y);
    // A human's second click comes after the double-click interval.
    await delay(600);
    const placed = await selection(editor);
    assert.deepEqual(placed, { anchor, head: anchor }, "the first click places the caret");
    const target = await widgetCentre(editor, widgetFrom);
    await editor.keyboard.down("Shift");
    await editor.mouse.click(target.x, target.y);
    await editor.keyboard.up("Shift");
    await delay(300);
    return await selection(editor);
  }

  it("extends forward over an equation", async function () {
    const anchor = DOCUMENT.indexOf("here");
    const from = DOCUMENT.indexOf(EQUATION);
    const extended = await extendToWidget(anchor, from);
    screenshots.set("forward-equation.png", await requireInitialized(page, "page").screenshot());
    assert.deepEqual(extended, { anchor, head: from + EQUATION.length });
  });

  it("extends forward over a wikilink chip", async function () {
    const anchor = DOCUMENT.indexOf("here");
    const from = DOCUMENT.indexOf(LINK);
    const extended = await extendToWidget(anchor, from);
    screenshots.set("forward-wikilink.png", await requireInitialized(page, "page").screenshot());
    assert.deepEqual(extended, { anchor, head: from + LINK.length });
  });

  it("extends backward over an equation", async function () {
    const anchor = DOCUMENT.indexOf("the end");
    const from = DOCUMENT.indexOf(EQUATION);
    const extended = await extendToWidget(anchor, from);
    screenshots.set("backward-equation.png", await requireInitialized(page, "page").screenshot());
    assert.deepEqual(extended, { anchor, head: from });
  });

  it("extends over a task checkbox and leaves the task unchecked", async function () {
    const anchor = DOCUMENT.indexOf("here");
    const from = DOCUMENT.indexOf(TASK);
    const extended = await extendToWidget(anchor, from);
    screenshots.set("forward-task.png", await requireInitialized(page, "page").screenshot());
    const text = await requireInitialized(page, "page").evaluate(() => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) throw new Error("No CodeMirror view is mounted");
      return view.state.doc.toString();
    });
    assert.equal(text, DOCUMENT, "a Shift-click on the checkbox does not toggle the task");
    assert.deepEqual(extended, { anchor, head: from + TASK.length });
  });
});

/**
 * Assembled-app proof that a key follows the link at the caret (#8).
 *
 * A Mod-click follows a wikilink, a cross-reference, a footnote, a tag and a
 * Markdown link. The command "Follow link" does the same for the caret: its
 * key is F12, the File menu carries it, and with no link at the caret it
 * changes nothing.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type EditorView } from "@codemirror/view";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  findMenuNode,
  preserveArtifacts,
  readApplicationMenu,
  shutdown,
} from "./support/electron-app";
import { leafIds, openInLeaf } from "./support/panes";

const INDEX = `# Index

Step: [[chain#Second step|the step]]

Forms: see @sec:forms for the details.

A line with no link.
`;

const CHAIN = `# First step

Start.

# Second step

Done.
`;

const FORMS = `# Lattices

A lattice.

# Quadratic forms {#sec:forms}

A form.
`;

const WORKSPACE: Record<string, string> = {
  "programs/chain.md": CHAIN,
  "foundations/forms.md": FORMS,
};

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

interface EditorPlace {
  text: string;
  cursorLine: number;
}

/** The text and the caret line of each mounted editor. */
async function editorPlaces(page: Page): Promise<EditorPlace[]> {
  return await page.locator(".cm-content").evaluateAll((contents) =>
    contents.map((content) => {
      const view = (content as EditorContentElement).cmTile?.root.view;
      if (view === undefined) {
        throw new Error("A mounted .cm-content has no CodeMirror view");
      }
      return {
        text: view.state.doc.toString(),
        cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number,
      };
    }),
  );
}

/** Waits until one editor shows a text with the caret on a line. */
async function waitForPlace(page: Page, text: string, line: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let places = await editorPlaces(page);
  while (!places.some((place) => place.text === text && place.cursorLine === line)) {
    assert.ok(
      Date.now() < deadline,
      `No editor showed the text with the caret on line ${line}: ${JSON.stringify(places)}`,
    );
    await delay(100);
    places = await editorPlaces(page);
  }
}

/** Puts the caret of the editor that shows a text at an offset, with the focus. */
async function placeCaret(page: Page, text: string, offset: number): Promise<void> {
  const placed = await page.locator(".cm-content").evaluateAll(
    (contents, [documentText, anchor]) =>
      contents.filter((content) => {
        const view = (content as EditorContentElement).cmTile?.root.view;
        if (view === undefined || view.state.doc.toString() !== documentText) {
          return false;
        }
        view.dispatch({ selection: { anchor } });
        view.focus();
        return true;
      }).length,
    [text, offset] as const,
  );
  assert.equal(placed, 1, "One editor must show the document that gets the caret");
}

function lineOf(text: string, needle: string): number {
  return text.slice(0, text.indexOf(needle)).split("\n").length;
}

describe("assembled app: a key follows the link at the caret", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let indexPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-follow-link-key-e2e-", {
      documentName: "index.md",
      documentContents: INDEX,
    });
    fixtureRoot = fixture.root;
    indexPath = fixture.documentPath;
    const workspace = path.dirname(fixture.documentPath);
    for (const [relativePath, contents] of Object.entries(WORKSPACE)) {
      await mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true });
      await writeFile(path.join(workspace, relativePath), contents, "utf8");
    }

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    // The chips show that the window has the links and the references of the
    // workspace.
    await page.locator(".wikilink-chip").waitFor({ timeout: this.timeout() });
    await page.locator(".reference-chip").waitFor({ timeout: this.timeout() });
  });

  after(async function () {
    if (page !== undefined) {
      screenshots.set("follow-link-key.png", await page.screenshot());
    }
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-follow-link-key-e2e-latest"),
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

  it("has the item Follow link with the key F12 in the File menu", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const item = findMenuNode(await readApplicationMenu(page), "menu.follow_link");
    assert.ok(item !== undefined, "The application menu must carry the Follow link item");
    assert.equal(item.accelerator, "F12");
  });

  it("changes nothing when the caret is on no link", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    await placeCaret(page, INDEX, INDEX.indexOf("no link"));
    await page.keyboard.press("F12");
    await delay(500);
    assert.deepEqual(await editorPlaces(page), [
      { text: INDEX, cursorLine: lineOf(INDEX, "no link") },
    ]);
  });

  it("opens the document of the wikilink at the caret, on its heading", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    await placeCaret(page, INDEX, INDEX.indexOf("chain#Second"));
    await page.keyboard.press("F12");
    await waitForPlace(page, CHAIN, lineOf(CHAIN, "# Second step"));
  });

  it("opens the definition of the cross-reference at the caret", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const [leaf] = await leafIds(page);
    await openInLeaf(page, leaf, indexPath);
    await page.locator(".reference-chip").waitFor({ timeout: 30_000 });
    await placeCaret(page, INDEX, INDEX.indexOf("sec:forms"));
    await page.keyboard.press("F12");
    await waitForPlace(page, FORMS, lineOf(FORMS, "{#sec:forms}"));
  });

  it("opens the definition of a cross-reference on a Mod-click on its chip (#47)", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const [leaf] = await leafIds(page);
    await openInLeaf(page, leaf, indexPath);
    // The test before this one left the caret in the cross-reference, which
    // shows its source there. The caret goes to the start of the document,
    // and the cross-reference is a chip again.
    await placeCaret(page, INDEX, 0);
    const chip = page.locator(".reference-chip").first();
    await chip.waitFor({ timeout: 30_000 });

    await chip.click({ modifiers: ["Control"] });

    await waitForPlace(page, FORMS, lineOf(FORMS, "{#sec:forms}"));
  });
});

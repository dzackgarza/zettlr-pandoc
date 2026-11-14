/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of the place in a reloaded document
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Another program rewrites the file of an open document
 *                  that has no unsaved text. The editor loads the new text
 *                  and keeps the place of the author: the paragraph at the
 *                  same height of the pane, the caret in its text, and the
 *                  folded section.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-remote-change-place-e2e-latest");
/** The editor of the tab that a pane shows; a pane keeps a hidden editor for each other tab. */
const EDITOR = ".cm-content:visible";
const SECTIONS = 240;
/** The view measures its lines again within this time after a scroll or a load. */
const VIEW_SETTLED_MS = 1_500;
/** A paragraph keeps its height in the pane within this many pixels. */
const SAME_HEIGHT_PX = 4;

/** The text of one section: a heading, a paragraph and a display equation. */
function section(index: number, paragraph: string): string {
  return `## Section ${index}\n\n${paragraph}\n\n$$\nx_{${index}} = ${index}\n$$\n\n`;
}

/** The paragraph of a section as the fixture writes it. */
function paragraphOf(index: number): string {
  return `Paragraph ${index}: the lattice of rank ${index} is even.`;
}

/** The paragraphs of the fixture, the paragraph of section 1 first. */
function fixtureParagraphs(): string[] {
  return Array.from({ length: SECTIONS }, (_, position) => paragraphOf(position + 1));
}

/**
 * The text of the document: the title, the lines that a program added after
 * it, and one section for each paragraph.
 */
function documentText(paragraphs: string[], added: string[]): string {
  const sections = paragraphs.map((paragraph, position) => section(position + 1, paragraph));
  return `# Lattices\n\n${added.map((line) => `${line}\n\n`).join("")}${sections.join("")}`;
}

/** A paragraph that the pane shows whole. */
interface ShownParagraph {
  index: number;
  text: string;
  /** The distance from the top of the pane to the top of the line, in pixels */
  top: number;
}

/** The place of the caret: the text of its line and the characters before it. */
interface CaretPlace {
  line: string;
  offset: number;
}

describe("an open document that another program rewrites", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notePath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const warnings: string[] = [];
  const screenshots = new Map<string, Buffer>();
  let writes = 0;

  /** Replaces the file as a program that writes a temporary file and renames it. */
  async function rewrite(text: string): Promise<void> {
    writes += 1;
    const temporary = `${notePath}.tmp.${process.pid}.${writes}`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, notePath);
  }

  /** The paragraphs that the pane shows whole, from the top. */
  function shownParagraphs(editorPage: Page): Promise<ShownParagraph[]> {
    return editorPage.evaluate(() => {
      const scroller = document.querySelector(".cm-scroller");
      if (scroller === null) {
        throw new Error("The window has no editor");
      }
      const pane = scroller.getBoundingClientRect();
      const shown: Array<{ index: number; text: string; top: number }> = [];
      for (const line of scroller.querySelectorAll(".cm-line")) {
        const text = line.textContent;
        const match = /^Paragraph (\d+):/.exec(text);
        const box = line.getBoundingClientRect();
        if (match !== null && box.top >= pane.top && box.bottom <= pane.bottom) {
          shown.push({ index: Number(match[1]), text, top: box.top - pane.top });
        }
      }
      return shown;
    });
  }

  /** The line of the caret and the count of characters of the line before it. */
  function caretPlace(editorPage: Page): Promise<CaretPlace> {
    return editorPage.evaluate(() => {
      const selection = window.getSelection();
      const anchor = selection === null ? null : selection.anchorNode;
      if (selection === null || anchor === null) {
        throw new Error("The window has no caret");
      }
      const element = anchor instanceof Element ? anchor : anchor.parentElement;
      const line = element === null ? null : element.closest(".cm-line");
      if (line === null) {
        throw new Error("The caret is in no line of the editor");
      }
      const before = document.createRange();
      before.setStart(line, 0);
      before.setEnd(anchor, selection.anchorOffset);
      return { line: line.textContent, offset: before.toString().length };
    });
  }

  /** The count of characters that the status bar of the window shows. */
  async function shownCharacterCount(editorPage: Page): Promise<string> {
    const status = await editorPage.locator("#main-statusbar").innerText();
    const count = /(\S+) characters/.exec(status);
    assert.ok(count !== null, `the status bar shows a count of characters: ${status}`);
    return count[1];
  }

  /** Waits until the editor shows another text than the one with this count. */
  async function editorLoadedAnotherText(editorPage: Page, countBefore: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while ((await shownCharacterCount(editorPage)) === countBefore) {
      assert.ok(Date.now() < deadline, "the editor loads the text that the program wrote");
      await delay(100);
    }
  }

  before(async function () {
    const fixture = await createFixture("zettlr-remote-change-place-e2e-", {
      documentName: "note.md",
      documentContents: documentText(fixtureParagraphs(), []),
    });
    fixtureRoot = fixture.root;
    notePath = fixture.documentPath;
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    page.on("console", (message) => {
      if (message.type() === "warning") {
        warnings.push(message.text());
      }
    });
    await page.locator(EDITOR).waitFor({ state: "visible", timeout: this.timeout() });
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

  it("keeps the paragraph, the caret and the fold of the author at each reload", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.locator(EDITOR).filter({ hasText: "Paragraph 1:" }).waitFor();
    await editorPage.evaluate(() => {
      const scroller = document.querySelector(".cm-scroller");
      if (scroller === null) {
        throw new Error("The window has no editor");
      }
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
    });
    await delay(VIEW_SETTLED_MS);

    const atStart = await shownParagraphs(editorPage);
    assert.ok(atStart.length >= 3, `the pane shows three paragraphs: ${JSON.stringify(atStart)}`);
    const [kept, changed, folded] = atStart;
    assert.ok(kept.index > 20, `the pane is far from the start of the document: ${kept.index}`);

    // Fold the section of the third paragraph with the control of its heading.
    const heading = editorPage
      .locator(".cm-line")
      .filter({ hasText: new RegExp(`Section ${folded.index}$`) });
    const headingBox = await heading.boundingBox();
    assert.ok(headingBox !== null, "the heading of the third paragraph is in the pane");
    const foldControls = editorPage.locator(".cm-foldGutter .cm-gutterElement");
    const controlBoxes = await foldControls.evaluateAll((controls) =>
      controls.map((control) => control.getBoundingClientRect().top),
    );
    const controlIndex = controlBoxes.findIndex((top) => Math.abs(top - headingBox.y) < 3);
    assert.ok(controlIndex >= 0, "the heading has a fold control");
    await foldControls.nth(controlIndex).locator("span").click();
    await editorPage.locator(".cm-foldPlaceholder").waitFor({ state: "visible" });

    // Put the caret into the first paragraph.
    await editorPage.locator(".cm-line").filter({ hasText: kept.text }).click();
    const caretAtStart = await caretPlace(editorPage);
    assert.equal(caretAtStart.line, kept.text, "the caret is in the first paragraph");
    await delay(VIEW_SETTLED_MS);
    const keptAtStart = (await shownParagraphs(editorPage)).find(
      (paragraph) => paragraph.index === kept.index,
    );
    assert.ok(keptAtStart !== undefined, "the first paragraph stays in the pane after the fold");

    const paragraphs = fixtureParagraphs();
    const added: string[] = [];
    for (const round of [1, 2, 3]) {
      // A change before the pane, a change in the pane and a change after it.
      added.push(`Line ${round} that another program added.`);
      const changedText = `${paragraphOf(changed.index)} Round ${round} of the change on disk.`;
      paragraphs[changed.index - 1] = changedText;
      paragraphs[SECTIONS - 1] = `${paragraphOf(SECTIONS)} Round ${round}.`;
      const countBefore = await shownCharacterCount(editorPage);
      await rewrite(documentText(paragraphs, added));
      await editorLoadedAnotherText(editorPage, countBefore);
      await delay(VIEW_SETTLED_MS);
      screenshots.set(`round-${round}.png`, await editorPage.screenshot());

      const keptNow = (await shownParagraphs(editorPage)).find(
        (paragraph) => paragraph.index === kept.index,
      );
      assert.ok(
        keptNow !== undefined,
        `round ${round}: the pane shows paragraph ${kept.index} as before the reload`,
      );
      assert.equal(
        await editorPage.locator(EDITOR).filter({ hasText: changedText }).count(),
        1,
        `round ${round}: the pane shows the text that the program wrote`,
      );
      assert.ok(
        Math.abs(keptNow.top - keptAtStart.top) <= SAME_HEIGHT_PX,
        `round ${round}: paragraph ${kept.index} is at ${keptNow.top} px of the pane, before the reload at ${keptAtStart.top} px`,
      );
      assert.deepEqual(
        await caretPlace(editorPage),
        caretAtStart,
        `round ${round}: the caret is at its place in paragraph ${kept.index}`,
      );
      assert.equal(
        await editorPage.locator(".cm-foldPlaceholder").count(),
        1,
        `round ${round}: section ${folded.index} is folded`,
      );
    }

    assert.deepEqual(
      warnings.filter((warning) => /Measure loop|Viewport failed/.test(warning)),
      [],
      "the view measures each reload without a restart limit",
    );
  });
});

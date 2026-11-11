/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Inline widget line break E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens a document whose paragraphs hold inline math,
 *                  reference chips, wikilink chips and citations beside
 *                  punctuation, and makes the window wider in steps of one
 *                  pixel, so that the end of a row passes each widget. At no
 *                  width does a row end between a widget and the punctuation
 *                  that touches it (#213).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-inline-widget-breaks-e2e-latest");

const REPEATS = 8;
const MATH = "set $X$, map ($f$); ".repeat(REPEATS).trimEnd();
const REFERENCES = "by @def:orbit, or (@def:orbit); ".repeat(REPEATS).trimEnd();
const WIKILINKS = "in [[notes]], or ([[notes]]); ".repeat(REPEATS).trimEnd();
const CITATIONS = "see [@Art91], or ([@Art91]); ".repeat(REPEATS).trimEnd();

const LIBRARY = `@book{Art91,
  author = {Artin, Michael},
  title = {Algebra},
  year = {1991},
  publisher = {Prentice Hall},
}
`;

const DOCUMENT = `# Line breaks beside widgets

::: {.definition #def:orbit title="Orbit"}

The orbit of a point.
:::

${MATH}

${REFERENCES}

${WIKILINKS}

${CITATIONS}
`;

const BASE_WIDTH = 620;
// Wider than one period of each paragraph, so the end of the first row
// passes a widget of each kind.
const SWEEP = 240;
// Two glyphs of one row have their centres nearer than this; the rows of
// the editor are more than twice this apart.
const ROW_TOLERANCE = 10;

type Kind = "math" | "reference chip" | "wikilink chip" | "citation";

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Glyph {
  char: string;
  box: Box;
}

interface Instance {
  kind: Kind;
  /**
   * The part of the widget on its first row and the part on its last row. A
   * citation is text, so its rows can be more than one.
   */
  start: Box;
  end: Box;
  /** The character of the line before the widget, and the one after it. */
  before: Glyph | null;
  after: Glyph | null;
}

// The function that runs in the page holds no named function: the TypeScript
// loader of the run wraps a named function in a helper that the page lacks.
function readInstances(page: Page): Promise<Instance[]> {
  return page.evaluate(() => {
    const instances: Instance[] = [];
    const boxes = document.querySelectorAll<HTMLElement>(
      ".cm-content mjx-container, .cm-content .reference-chip, .cm-content .wikilink-chip, .cm-content .citeproc-citation",
    );
    for (const element of boxes) {
      const root = element.closest("[data-preview-source-length]");
      const line = element.closest(".cm-line");
      if (root === null || line === null) {
        throw new Error("A widget of this document is not a widget of a line");
      }
      let before: Text | null = null;
      let after: Text | null = null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (root.contains(node) || node.data.length === 0) {
          continue;
        }
        if ((root.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) {
          before = node;
        } else if (after === null) {
          after = node;
        }
      }
      const glyphs: Array<Glyph | null> = [];
      for (const [node, offset] of [
        [before, before === null ? 0 : before.data.length - 1],
        [after, 0],
      ] as const) {
        if (node === null) {
          glyphs.push(null);
          continue;
        }
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        glyphs.push({
          char: node.data.charAt(offset),
          box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        });
      }
      const rects = element.getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];
      instances.push({
        kind:
          element.tagName === "MJX-CONTAINER"
            ? "math"
            : element.classList.contains("reference-chip")
              ? "reference chip"
              : element.classList.contains("wikilink-chip")
                ? "wikilink chip"
                : "citation",
        start: { left: first.left, right: first.right, top: first.top, bottom: first.bottom },
        end: { left: last.left, right: last.right, top: last.top, bottom: last.bottom },
        before: glyphs[0],
        after: glyphs[1],
      });
    }
    return instances;
  });
}

function centre(box: Box): number {
  return (box.top + box.bottom) / 2;
}

function onOneRow(a: Box, b: Box): boolean {
  return Math.abs(centre(a) - centre(b)) < ROW_TOLERANCE;
}

describe("assembled app: line breaks beside inline widgets", function () {
  this.timeout(300_000);

  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-inline-widget-breaks-e2e-", {
      documentName: "breaks.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: true,
        autoDarkMode: "off",
        editor: { fontSize: 18 },
        window: { fileManagerVisible: false, sidebarVisible: false },
      },
    });
    fixtureRoot = fixture.root;
    await writeFile(path.join(path.dirname(fixture.documentPath), "notes.md"), "# Notes\n", "utf8");
    const libraryPath = path.join(fixture.root, "references.bib");
    await writeFile(libraryPath, LIBRARY, "utf8");
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.export = { cslLibrary: libraryPath };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: BASE_WIDTH, height: 900 });
    for (const selector of [
      "mjx-container",
      ".reference-chip",
      ".wikilink-chip",
      ".citeproc-citation:not(.citeproc-pending):not(.error)",
    ]) {
      await page
        .locator(`.cm-content ${selector}`)
        .nth(2 * REPEATS - 1)
        .waitFor({ state: "visible", timeout: this.timeout() });
    }
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
    assertCleanExit(getOutput());
  });

  it("ends no row between a widget and the punctuation that touches it", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const kinds: Kind[] = ["math", "reference chip", "wikilink chip", "citation"];
    const separated: string[] = [];
    const widgetsOnFirstRow = new Map<Kind, Set<number>>(kinds.map((kind) => [kind, new Set()]));

    for (let width = BASE_WIDTH; width <= BASE_WIDTH + SWEEP; width++) {
      await editorPage.setViewportSize({ width, height: 900 });
      const instances = await readInstances(editorPage);
      assert.deepEqual(
        kinds.map((kind) => instances.filter((instance) => instance.kind === kind).length),
        [2 * REPEATS, 2 * REPEATS, 2 * REPEATS, 2 * REPEATS],
        "each widget of the document is drawn",
      );
      const separatedBefore = separated.length;
      for (const kind of kinds) {
        const ofKind = instances.filter((instance) => instance.kind === kind);
        const firstRow = ofKind.filter((instance) => onOneRow(instance.start, ofKind[0].start));
        widgetsOnFirstRow.get(kind)?.add(firstRow.length);
        for (const instance of ofKind) {
          for (const [glyph, part] of [
            [instance.before, instance.start],
            [instance.after, instance.end],
          ] as const) {
            if (glyph === null || glyph.char.trim() === "") {
              continue;
            }
            if (!onOneRow(glyph.box, part)) {
              separated.push(`${kind} and "${glyph.char}" at a window of ${String(width)} px`);
            }
          }
        }
      }
      if (separatedBefore === 0 && separated.length > 0) {
        screenshots.set("first-separation.png", await editorPage.screenshot());
      }
    }
    screenshots.set("widest.png", await editorPage.screenshot());

    for (const kind of kinds) {
      const counts = requireInitialized(widgetsOnFirstRow.get(kind), `the sweep counts ${kind}`);
      assert.ok(
        counts.size > 1,
        `the end of the first row passed a ${kind}: the row held ${[...counts].join(", ")} of them`,
      );
    }
    assert.deepEqual(separated, []);
  });
});

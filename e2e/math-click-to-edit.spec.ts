/**
 * Assembled-app proof that rendered inline math can be clicked into and edited.
 *
 * A click on a rendered equation reveals its TeX source. A second click inside
 * that source must put the caret on the clicked character and keep the source
 * revealed, so the author can edit it. CodeMirror maps a click to a document
 * position through its height map, so the map must agree with the rendered
 * DOM: the front matter card above the equation is part of the fixture.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
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
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";

const EQUATION = "$(\\PP^2)^{10}\\modmod\\PGL_3$";
const DOCUMENT = `---
title: The Coble cusp correspondence
tags: [coble, moduli]
---

# Moduli

::: {.remark title="The GIT birational model"}

$\\fco \\definedas D_{T_{\\Co}}/\\Orth(T_{\\Co})$ is claimed birational to the GIT quotient ${EQUATION}.
This gives an independent handle on the dimension 9 already asserted in the project.
:::

Outside probe.
`;

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

interface EditorSnapshot {
  anchor: number;
  head: number;
  revealed: boolean;
}

describe("assembled editor: click into rendered math to edit it", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-math-click-e2e-", {
      documentName: "math-click.md",
      documentContents: DOCUMENT,
    });
    fixtureRoot = fixture.root;

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    await page.locator(".cm-line", { hasText: "Outside probe." }).click();
  });

  after(async function () {
    if (page !== undefined) {
      screenshots.set("math-click.png", await page.screenshot());
    }
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-math-click-e2e-latest"),
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

  /**
   * The centre of the rendered widget of the equation, or null when its source
   * is revealed. A widget holds no document position, so the view says where
   * each widget is, as the production click handler asks it.
   */
  async function renderedEquationCentre(
    activePage: Page,
  ): Promise<{ x: number; y: number } | null> {
    return await activePage.evaluate((from) => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) throw new Error("No CodeMirror view is mounted");
      const widget = Array.from(
        view.contentDOM.querySelectorAll<HTMLElement>("[data-preview-source-length]"),
      ).find((element) => view.posAtDOM(element) === from);
      if (widget === undefined) return null;
      const rect = widget.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, DOCUMENT.indexOf(EQUATION));
  }

  async function snapshot(activePage: Page): Promise<EditorSnapshot> {
    const selection = await activePage.evaluate(() => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) throw new Error("No CodeMirror view is mounted");
      return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
    });
    return { ...selection, revealed: (await renderedEquationCentre(activePage)) === null };
  }

  it("keeps the CodeMirror height map aligned with every rendered block", async function () {
    assert.ok(page !== undefined, "the assembled editor page must be available");
    const misaligned = await page.evaluate(() => {
      const content = document.querySelector<EditorContentElement>(".cm-content");
      const view = content?.cmTile?.root.view;
      if (content === null || view === undefined) throw new Error("No CodeMirror view is mounted");
      const offsets: Array<{ text: string; offset: number }> = [];
      for (const element of Array.from(content.children)) {
        const block = view.lineBlockAt(view.posAtDOM(element, 0));
        const offset = element.getBoundingClientRect().top - (block.top + view.documentTop);
        if (Math.abs(offset) > 1) {
          offsets.push({ text: (element.textContent ?? "").slice(0, 40), offset });
        }
      }
      return offsets;
    });
    assert.deepEqual(
      misaligned,
      [],
      "rendered blocks sit away from the positions CodeMirror maps clicks to",
    );
  });

  for (const needle of ["\\PGL_3", "\\modmod", "^{10}", "(\\PP"]) {
    it(`puts the caret on ${needle} when the revealed source is clicked there`, async function () {
      assert.ok(page !== undefined, "the assembled editor page must be available");
      await page.locator(".cm-line", { hasText: "Outside probe." }).click();
      await delay(600);

      const widget = await renderedEquationCentre(page);
      assert.ok(widget !== null, "with the caret outside, the equation must be rendered");
      await page.mouse.click(widget.x, widget.y);
      const revealed = await snapshot(page);
      assert.ok(revealed.revealed, "a click on the rendered equation must reveal its source");

      // A human's second click comes after the double-click interval.
      await delay(600);
      const target = DOCUMENT.indexOf(needle);
      const point = await page.evaluate((position) => {
        const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
        if (view === undefined) throw new Error("No CodeMirror view is mounted");
        const start = view.coordsAtPos(position, 1);
        const end = view.coordsAtPos(position + 1, -1);
        if (start === null || end === null) throw new Error(`No layout at ${position}`);
        return { x: (start.left + end.left) / 2, y: (start.top + start.bottom) / 2 };
      }, target);
      await page.mouse.click(point.x, point.y);
      await delay(300);

      const edited = await snapshot(page);
      screenshots.set(
        `math-click-${needle.replace(/[^A-Za-z0-9]/g, "")}.png`,
        await page.screenshot(),
      );
      assert.ok(
        edited.revealed,
        `clicking inside the revealed source re-rendered the equation (selection ${edited.anchor}-${edited.head})`,
      );
      assert.equal(edited.anchor, edited.head, "a single click must leave a caret, not a range");
      assert.ok(
        edited.anchor === target || edited.anchor === target + 1,
        `clicking ${needle} (source ${target}) put the caret at ${edited.anchor}`,
      );
    });
  }
});

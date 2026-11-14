/**
 * Assembled-app proof that a chip shows that it is a link (#8).
 *
 * A cross-reference chip and a wikilink chip follow their target on a
 * Mod-click. A chip under the pointer has the pointer cursor and a stronger
 * tint. While the Mod key is held, the label of that chip has the underline
 * and the colour of a link. The tooltip of a chip names the two gestures; the
 * tooltip of the source text names the one that it has.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type EditorView } from "@codemirror/view";
import { type Browser, type Page } from "playwright";
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

const INDEX = `# Index

Step: [[chain#Second step|the step]]

Forms: see @sec:forms for the details.

A line with no link.
`;

const WORKSPACE: Record<string, string> = {
  "programs/chain.md": "# First step\n\nStart.\n\n# Second step\n\nDone.\n",
  "foundations/forms.md": "# Lattices\n\nA lattice.\n\n# Quadratic forms {#sec:forms}\n\nA form.\n",
};

interface Chip {
  name: string;
  selector: string;
  /** A text of the source of the chip. */
  source: string;
  chipGesture: string;
  sourceGesture: string;
}

const CHIPS: Chip[] = [
  {
    name: "cross-reference",
    selector: ".reference-chip",
    source: "@sec:forms",
    chipGesture: "Ctrl+Click to go to definition · Click to reveal source",
    sourceGesture: "Ctrl+Click to go to definition",
  },
  {
    name: "wikilink",
    selector: ".wikilink-chip",
    source: "chain#Second",
    chipGesture: "Ctrl+Click to open · Click to reveal source",
    sourceGesture: "Ctrl+Click to open",
  },
];

const GESTURE = ".cm-tooltip-hover [data-link-gesture]";

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

interface ChipLook {
  cursor: string;
  background: string;
  color: string;
  underlined: boolean;
  /** The colour that the theme gives a link. */
  linkColor: string;
}

async function lookOf(page: Page, selector: string): Promise<ChipLook> {
  return await page.locator(selector).evaluate((chip) => {
    const editor = chip.closest(".cm-editor");
    if (editor === null) {
      throw new Error("The chip is in no editor");
    }
    const probe = document.createElement("span");
    probe.style.color = "var(--zettlr-editor-primary-color)";
    editor.appendChild(probe);
    const linkColor = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(chip);
    return {
      cursor: style.cursor,
      background: style.backgroundColor,
      color: style.color,
      underlined: style.textDecorationLine.includes("underline"),
      linkColor,
    };
  });
}

/** The opacity of an `rgba()` colour. */
function alphaOf(color: string): number {
  const alpha = /^rgba\(\d+, \d+, \d+, ([\d.]+)\)$/.exec(color)?.[1];
  assert.ok(alpha !== undefined, `${color} is a colour with an opacity`);
  return Number(alpha);
}

/** Takes the pointer off the text and waits until no hover tooltip is open. */
async function leaveText(page: Page): Promise<void> {
  await page.mouse.move(5, 5);
  await page.locator(".cm-tooltip-hover").waitFor({ state: "detached", timeout: 20_000 });
}

/** Puts the caret at a text of the document. */
async function placeCaret(page: Page, text: string): Promise<void> {
  await page.locator(".cm-content").evaluate((content, needle) => {
    const view = (content as EditorContentElement).cmTile?.root.view;
    if (view === undefined) {
      throw new Error("The mounted .cm-content has no CodeMirror view");
    }
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(needle) + 1 } });
  }, text);
}

describe("assembled app: a chip shows that it is a link", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** A picture of the lines of the document and of what is open over them. */
  async function capture(name: string): Promise<void> {
    const shown = requireInitialized(page, "editor page");
    const box = await shown.locator(".cm-content").boundingBox();
    assert.ok(box !== null, "The editor has a content box");
    screenshots.set(
      name,
      await shown.screenshot({
        clip: {
          x: box.x,
          y: Math.max(box.y - 150, 0),
          width: Math.min(box.width, 700),
          height: 480,
        },
      }),
    );
  }

  before(async function () {
    const fixture = await createFixture("zettlr-chip-link-affordance-e2e-", {
      documentName: "index.md",
      documentContents: INDEX,
      config: { darkMode: true },
    });
    fixtureRoot = fixture.root;
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
    for (const chip of CHIPS) {
      await page.locator(chip.selector).waitFor({ timeout: this.timeout() });
    }
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-chip-link-affordance-e2e-latest"),
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

  beforeEach(async function () {
    const shown = requireInitialized(page, "editor page");
    await leaveText(shown);
    await placeCaret(shown, "no link");
    for (const chip of CHIPS) {
      await shown.locator(chip.selector).waitFor({ timeout: 10_000 });
    }
  });

  for (const mode of ["dark", "light"] as const) {
    describe(`in ${mode} mode`, function () {
      before(async function () {
        const shown = requireInitialized(page, "editor page");
        await shown.evaluate((dark) => {
          window.config.set("darkMode", dark);
        }, mode === "dark");
        await shown.waitForFunction(
          (dark) => document.body.classList.contains("dark") === dark,
          mode === "dark",
          { timeout: 10_000 },
        );
      });

      for (const chip of CHIPS) {
        it(`gives a ${chip.name} chip under the pointer the pointer cursor and a stronger tint`, async function () {
          const shown = requireInitialized(page, "editor page");
          const resting = await lookOf(shown, chip.selector);
          await capture(`${mode}-${chip.name}-1-resting.png`);

          await shown.locator(chip.selector).hover();
          const hovered = await lookOf(shown, chip.selector);
          await capture(`${mode}-${chip.name}-2-hover.png`);

          assert.equal(hovered.cursor, "pointer");
          assert.ok(
            alphaOf(hovered.background) > alphaOf(resting.background),
            `the tint under the pointer (${hovered.background}) is stronger than the tint at rest (${resting.background})`,
          );
          assert.equal(hovered.underlined, false, "without the Mod key the label has no underline");
          assert.equal(
            hovered.color,
            resting.color,
            "without the Mod key the label keeps its colour",
          );
        });

        it(`gives a ${chip.name} chip under the pointer the look of a link while Ctrl is held`, async function () {
          const shown = requireInitialized(page, "editor page");
          const resting = await lookOf(shown, chip.selector);

          // The key goes down while the pointer is on the chip.
          await shown.locator(chip.selector).hover();
          await shown.keyboard.down("Control");
          const held = await lookOf(shown, chip.selector);
          await capture(`${mode}-${chip.name}-3-ctrl-held.png`);
          await shown.keyboard.up("Control");
          const released = await lookOf(shown, chip.selector);

          assert.equal(held.underlined, true, "the label has the underline while Ctrl is held");
          assert.equal(held.color, held.linkColor, "the label has the colour of a link");
          assert.equal(released.underlined, false, "the underline goes with the key");
          assert.equal(released.color, resting.color, "the colour of the label comes back");

          // The pointer comes to the chip while the key is down.
          await leaveText(shown);
          await shown.keyboard.down("Control");
          await shown.locator(chip.selector).hover();
          const arrived = await lookOf(shown, chip.selector);
          await shown.mouse.move(5, 5);
          const left = await lookOf(shown, chip.selector);
          await shown.keyboard.up("Control");

          assert.equal(
            arrived.underlined,
            true,
            "a chip that the pointer reaches with Ctrl held has the underline",
          );
          assert.equal(left.underlined, false, "a chip that the pointer left has no underline");
        });

        it(`names the two gestures in the tooltip of a ${chip.name} chip`, async function () {
          const shown = requireInitialized(page, "editor page");
          await shown.locator(chip.selector).hover();
          const gesture = shown.locator(GESTURE);
          await gesture.waitFor({ state: "visible", timeout: 5_000 });
          await capture(`${mode}-${chip.name}-4-tooltip.png`);
          assert.deepEqual(await gesture.allInnerTexts(), [chip.chipGesture]);
        });
      }
    });
  }

  describe("in the source text", function () {
    for (const chip of CHIPS) {
      it(`names the one gesture of the source text of a ${chip.name}`, async function () {
        const shown = requireInitialized(page, "editor page");
        // The caret in the source of a chip shows that source.
        await placeCaret(shown, chip.source);
        await shown.locator(chip.selector).waitFor({ state: "detached", timeout: 10_000 });
        await hoverText(shown, chip.source);
        const gesture = shown.locator(GESTURE);
        await gesture.waitFor({ state: "visible", timeout: 5_000 });
        await capture(`source-${chip.name}-tooltip.png`);
        assert.deepEqual(await gesture.allInnerTexts(), [chip.sourceGesture]);
      });
    }
  });
});

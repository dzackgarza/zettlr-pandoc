/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Titled fenced div E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens a document of Pandoc fenced divs with `title`
 *                  attributes in the assembled app. At a wide and at a narrow
 *                  window each header shows its label and its whole title,
 *                  the badges of a definition are in the editor and beside
 *                  the title, and the editor has no horizontal scroll. A
 *                  definition far below the first one gets its badges when
 *                  the author scrolls to it (#177). The badges of a heading
 *                  with an id are beside the text of the heading or on a row
 *                  of their own, and never on that text (#212).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-titled-div-e2e-latest");

const LONG_TITLE = "Orbit, stabilizer, and the set of fixed points of a group action";
const REMARK_TITLE = "Standard terminology and the convention of the database";
const SHORT_TITLE = "Transitive actions";
const LAST_KEY = "def:free-action";

// Enough text that the editor draws the first and the last definition in
// different viewports.
const FILLER = Array.from(
  { length: 240 },
  (_, index) => `Paragraph ${String(index + 1)} between the definitions.\n`,
).join("\n");

// Headings with an id, each one word longer than the one before it: at each
// width of the window some of them end where the row has no room for badges.
const HEADING_WORDS =
  "Orbits of a finite group that acts on the left cosets of a subgroup by a left translation of each coset".split(
    " ",
  );
const HEADING_KEYS = HEADING_WORDS.map((_, index) => `sec:step-${String(index + 1)}`);
const HEADINGS = HEADING_WORDS.map(
  (_, index) =>
    `### Step ${String(index + 1)}: ${HEADING_WORDS.slice(0, index + 1).join(" ")} {#${HEADING_KEYS[index]}}\n`,
).join("\n");

const DOCUMENT = `## Orbits and stabilizers

::: {.definition #def:orbit-stabilizer-fixed-points title="${LONG_TITLE}"}

Let $G$ be a group that acts on a set $X$, and let $x\\in X$.

The **orbit** of $x$ is
$$
G\\cdot x
=
\\{g\\cdot x \\mid g\\in G\\}
.
$$
The **stabilizer** of $x$ is the subgroup $G_x=\\{g\\in G\\mid g\\cdot x=x\\}$.
:::

::: {.remark title="${REMARK_TITLE}"}

The database fields \`action.orbit_representatives\`, \`action.stabilizer_generators\`, and \`action.fixed_point_count\` use this convention.
:::

::: {.definition #def:transitive-action title="${SHORT_TITLE}"}

The action is **transitive** if $X$ is one orbit.
:::

${FILLER}
${HEADINGS}
::: {.definition #${LAST_KEY} title="Free actions"}

The action is **free** if each stabilizer is trivial.
:::
`;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface HeaderLayout {
  label: string;
  title: string;
  /** The box of the title element: what the element shows of its text. */
  titleBox: Box;
  /** The rows of the title text, as the text is laid out. */
  textRows: Box[];
}

interface EditorLayout {
  clientWidth: number;
  scrollWidth: number;
  visible: Box;
  headers: HeaderLayout[];
  badges: Array<{ key: string; box: Box }>;
}

// The functions that run in the page hold no named function: the TypeScript
// loader of the run wraps a named function in a helper that the page lacks.
function readLayout(page: Page): Promise<EditorLayout> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (scroller === null) {
      throw new Error("The editor has no scroller");
    }
    const headers = [...scroller.querySelectorAll(".pandoc-div-header")].map((header) => {
      const title = header.querySelector(".pandoc-div-header-title");
      if (title === null) {
        throw new Error("A header of this document has no title element");
      }
      const label = header.querySelector(".pandoc-div-header-label");
      if (label === null) {
        throw new Error("A header of this document has no label element");
      }
      const labelText = label.textContent;
      const titleText = title.textContent;
      if (labelText === null || titleText === null) {
        throw new Error("A header of this document has a label or a title without text");
      }
      const titleRect = title.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(title);
      return {
        label: labelText,
        title: titleText,
        titleBox: {
          left: titleRect.left,
          right: titleRect.right,
          top: titleRect.top,
          bottom: titleRect.bottom,
        },
        textRows: [...text.getClientRects()].map((rect) => ({
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        })),
      };
    });
    const badges = [...scroller.querySelectorAll(".reference-badge-group.positioned")].map(
      (group) => {
        const rect = group.getBoundingClientRect();
        const key = group.querySelector<HTMLElement>(".reference-definition-badge")?.dataset
          .referenceKey;
        if (key === undefined) {
          throw new Error("A badge group has no badge with a reference key");
        }
        return {
          key,
          box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        };
      },
    );
    const visible = scroller.getBoundingClientRect();
    return {
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      visible: {
        left: visible.left,
        right: visible.right,
        top: visible.top,
        bottom: visible.bottom,
      },
      headers,
      badges,
    };
  });
}

interface HeadingLayout {
  key: string;
  /** The box of the line of the heading. */
  line: Box;
  /** The rows of the text of the heading: the boxes of its text nodes. */
  textRows: Box[];
  /** The box of the badge group of the heading; null when it has no place. */
  badges: Box | null;
}

function readHeadings(page: Page, keys: string[]): Promise<HeadingLayout[]> {
  return page.evaluate((headingKeys) => {
    const scroller = document.querySelector(".cm-scroller");
    if (scroller === null) {
      throw new Error("The editor has no scroller");
    }
    const lines = [...scroller.querySelectorAll(".cm-line")];
    return headingKeys.map((key) => {
      const step = `Step ${key.slice("sec:step-".length)}:`;
      const line = lines.find((candidate) => candidate.textContent?.includes(step) === true);
      if (line === undefined) {
        throw new Error(`The editor draws no line for ${key}`);
      }
      const textRows = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() !== null) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && rect.height > 0) {
            textRows.push({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            });
          }
        }
      }
      const group = scroller
        .querySelector(`.reference-badge-group.positioned [data-reference-key="${key}"]`)
        ?.closest(".reference-badge-group");
      const groupRect = group?.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      return {
        key,
        line: {
          left: lineRect.left,
          right: lineRect.right,
          top: lineRect.top,
          bottom: lineRect.bottom,
        },
        textRows,
        badges:
          groupRect === undefined
            ? null
            : {
                left: groupRect.left,
                right: groupRect.right,
                top: groupRect.top,
                bottom: groupRect.bottom,
              },
      };
    });
  }, keys);
}

function overlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("assembled app: fenced divs with a title", function () {
  this.timeout(300_000);

  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-titled-div-e2e-", {
      documentName: "actions.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: true,
        editor: { fontSize: 18 },
        window: { fileManagerVisible: false, sidebarVisible: false },
      },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".pandoc-div-header").first().waitFor({
      state: "visible",
      timeout: this.timeout(),
    });
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

  for (const width of [1400, 620]) {
    it(`shows each label, each whole title and each badge at a window of ${String(width)} px`, async function () {
      const editorPage = requireInitialized(page, "The editor window must be open");
      await editorPage.setViewportSize({ width, height: 900 });
      await editorPage
        .locator(".reference-badge-group.positioned")
        .nth(1)
        .waitFor({ state: "visible", timeout: 30_000 });
      // The badges take their places in the measure cycle after a resize.
      await delay(1000);
      screenshots.set(`titled-divs-${String(width)}.png`, await editorPage.screenshot());

      const layout = await readLayout(editorPage);
      assert.deepEqual(
        layout.headers.map((header) => [header.label, header.title]),
        [
          ["Definition", LONG_TITLE],
          ["Remark", REMARK_TITLE],
          ["Definition", SHORT_TITLE],
        ],
      );
      for (const header of layout.headers) {
        assert.ok(header.textRows.length > 0, `the title has text: ${header.title}`);
        for (const row of header.textRows) {
          assert.ok(
            row.right <= header.titleBox.right + 1 && row.bottom <= header.titleBox.bottom + 1,
            `the title element shows its whole text: ${header.title}`,
          );
          assert.ok(
            row.right <= layout.visible.right + 1,
            `the title ends in the editor: ${header.title} ends at ${String(row.right)}, the editor at ${String(layout.visible.right)}`,
          );
        }
      }
      assert.equal(layout.scrollWidth, layout.clientWidth, "the editor has no horizontal scroll");
      assert.deepEqual(
        layout.badges.map((badge) => badge.key),
        ["def:orbit-stabilizer-fixed-points", "def:transitive-action"],
      );
      for (const badge of layout.badges) {
        assert.ok(
          badge.box.right <= layout.visible.right + 1,
          `the badges of ${badge.key} end in the editor: ${String(badge.box.right)} > ${String(layout.visible.right)}`,
        );
        for (const header of layout.headers) {
          assert.ok(
            !header.textRows.some((row) => overlap(badge.box, row)),
            `the badges of ${badge.key} do not cover the title: ${header.title}`,
          );
        }
      }
    });
  }

  it("gives the badges of a definition that the author scrolls to", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const badges = editorPage.locator(
      `.reference-badge-group.positioned .reference-count-badge[data-reference-key="${LAST_KEY}"]`,
    );
    assert.equal(await badges.count(), 0, "the last definition starts outside the viewport");

    await editorPage
      .locator(".cm-scroller")
      .evaluate((scroller) => scroller.scrollTo(0, scroller.scrollHeight));
    const header = editorPage.locator(".pandoc-div-header", { hasText: "Free actions" });
    await header.waitFor({ state: "visible", timeout: 30_000 });
    // The badges take their places in the measure cycle after a scroll.
    await delay(1000);
    screenshots.set("titled-divs-last-definition.png", await editorPage.screenshot());

    assert.equal(await badges.count(), 1, "the last definition has its badges");
    const layout = await readLayout(editorPage);
    const badge = layout.badges.find((candidate) => candidate.key === LAST_KEY);
    assert.ok(badge !== undefined, "the badges of the last definition have a place");
    assert.ok(
      badge.box.top >= layout.visible.top && badge.box.bottom <= layout.visible.bottom,
      "the badges of the last definition are in the visible part of the editor",
    );
  });

  for (const width of [1400, 620]) {
    it(`puts the badges of a heading beside its text or below it at a window of ${String(width)} px`, async function () {
      const editorPage = requireInitialized(page, "The editor window must be open");
      // The window is high enough to show every heading of the series.
      await editorPage.setViewportSize({ width, height: 4000 });
      await editorPage
        .locator(".cm-scroller")
        .evaluate((scroller) => scroller.scrollTo(0, scroller.scrollHeight));
      await editorPage
        .locator(`.reference-badge-group.positioned [data-reference-key="${HEADING_KEYS[0]}"]`)
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      // The badges take their places in the measure cycle after a resize.
      await delay(1000);
      screenshots.set(`heading-badges-${String(width)}.png`, await editorPage.screenshot());

      const layout = await readLayout(editorPage);
      const headings = await readHeadings(editorPage, HEADING_KEYS);
      assert.equal(layout.scrollWidth, layout.clientWidth, "the editor has no horizontal scroll");

      const allTextRows = headings.flatMap((heading) => heading.textRows);
      let beside = 0;
      let below = 0;
      for (const heading of headings) {
        const badges = heading.badges;
        assert.ok(badges !== null, `the heading ${heading.key} has its badges`);
        assert.ok(heading.textRows.length > 0, `the heading ${heading.key} has text`);
        assert.ok(
          !allTextRows.some((row) => overlap(badges, row)),
          `the badges of ${heading.key} cover no text of a heading`,
        );
        assert.ok(
          badges.left >= layout.visible.left - 1 && badges.right <= layout.visible.right + 1,
          `the badges of ${heading.key} are in the editor`,
        );
        assert.ok(
          badges.top >= heading.line.top - 1 && badges.bottom <= heading.line.bottom + 1,
          `the badges of ${heading.key} are in the line of the heading`,
        );
        const lastRowBottom = Math.max(...heading.textRows.map((row) => row.bottom));
        if (badges.top >= lastRowBottom - 1) {
          below += 1;
        } else {
          beside += 1;
        }
      }
      // The series holds both cases at this width; without both, the
      // assertions above do not prove the rule.
      assert.ok(beside > 0, "a heading of the series has its badges beside its text");
      assert.ok(below > 0, "a heading of the series has its badges on a row of their own");
    });
  }
});

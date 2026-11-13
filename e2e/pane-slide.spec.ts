/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Slide of a side pane E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author opens and closes the Annotations view and the
 *                  navigation sidebar beside a long document with a review.
 *                  A pane slides for 180 ms. The editor takes the width of the
 *                  end of the slide one time: it does not wrap its document
 *                  again for each frame of the slide (#126).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPatch } from "diff";
import { type Browser, type Page } from "playwright";
import { sha256Text } from "../source/common/util/sha256";
import {
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  readAgentApiPort,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-pane-slide-e2e-latest");
const PARAGRAPHS = 300;
const REVIEWED_PARAGRAPHS = 20;
const EDITOR_PANE = '[data-pane="editor"]';

/** A paragraph long enough that its wrap follows the width of the editor. */
function paragraph(index: number): string {
  return (
    `Let $L_{${index}}$ be an even lattice of signature $(2, ${index})$ and let $A_{L_{${index}}}$ ` +
    "be its discriminant group with the quadratic form that the lattice gives it. " +
    "The genus of the lattice is the set of the lattices that are isometric to it over each " +
    "localization, and the discriminant form and the signature decide the genus. " +
    "An isometry of the discriminant form lifts to the lattice when the lattice is indefinite " +
    "and its rank is larger than the length of the discriminant group by two."
  );
}

const DOCUMENT = `# Genera\n\n${Array.from({ length: PARAGRAPHS }, (_, index) => paragraph(index)).join("\n\n")}\n`;
const PROPOSED = DOCUMENT.split("\n")
  .map((line, index) =>
    index >= 2 && index < 2 + 2 * REVIEWED_PARAGRAPHS
      ? line.replace("each localization", "each completion")
      : line,
  )
  .join("\n");

type SidePane = "window.sidebarVisible" | "window.fileManagerVisible";

/**
 * Shows or hides one side pane, and gives each width that the scroller of the
 * editor had from the change of the setting until the slide is over. The
 * first width is the width before the slide.
 */
async function editorWidthsOfSlide(
  page: Page,
  pane: SidePane,
  visible: boolean,
): Promise<number[]> {
  return await page.evaluate(
    async ({ selector, key, value }) => {
      const scroller = document.querySelector(`${selector} .cm-scroller`);
      if (scroller === null) {
        throw new Error("The editor pane has no scroller");
      }
      const widths: number[] = [];
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = Math.round(entry.contentRect.width);
          if (widths.at(-1) !== width) {
            widths.push(width);
          }
        }
      });
      observer.observe(scroller);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.config.set(key, value);
      await new Promise((resolve) => setTimeout(resolve, 800));
      observer.disconnect();
      return widths;
    },
    { selector: EDITOR_PANE, key: pane, value: visible },
  );
}

describe("assembled app: the slide of a side pane", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-pane-slide-e2e-", {
      documentName: "genera.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        agentApi: { enabled: true, port: 0 },
        window: { fileManagerVisible: false, sidebarVisible: false },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    documentPath = fixture.documentPath;
    const app = await attach(configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    await page.setViewportSize({ width: 1500, height: 950 });

    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));
    await api.post("/v1/review-submissions", {
      document: { uri: documentPath },
      baseline: { sha256: sha256Text(DOCUMENT) },
      clientRequestId: "pane-slide",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(documentPath, DOCUMENT, PROPOSED, "", "", { context: 0 }),
        },
      ],
    });
    await page
      .locator("input.suggestion-chunk-comment")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
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

  for (const [pane, name] of [
    ["window.sidebarVisible", "the Annotations view"],
    ["window.fileManagerVisible", "the navigation sidebar"],
  ] as const) {
    it(`gives the editor one new width when ${name} slides open and shut`, async function () {
      const editorPage = requireInitialized(page, "The editor window must be open");
      const opened = await editorWidthsOfSlide(editorPage, pane, true);
      screenshots.set(`${pane}-open.png`, await editorPage.screenshot());
      const closed = await editorWidthsOfSlide(editorPage, pane, false);
      screenshots.set(`${pane}-shut.png`, await editorPage.screenshot());

      assert.equal(
        opened.length,
        2,
        `an open gives the editor one new width: ${opened.join(", ")}`,
      );
      assert.ok(opened[1] < opened[0], "the open pane takes room from the editor");
      assert.deepEqual(closed, [opened[1], opened[0]], "a close gives the editor its width back");
    });
  }
});

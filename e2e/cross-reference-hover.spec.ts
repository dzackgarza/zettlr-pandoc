/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The hover of a cross-reference and of a citation
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     `@fig-lattice` and `@Nik80` have the syntax of a Pandoc
 *                  citation. The first is a cross-reference to a figure of
 *                  the workspace: its hover shows the figure and asks the
 *                  library for no entry. The second is a key of the library:
 *                  its hover shows the bibliography entry.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { hoverText } from "./support/editor-hover";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  type RunningApp,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-cross-reference-hover-e2e-latest");

const LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`;

const DOCUMENT = [
  "# Lattices",
  "",
  "![The E8 root lattice](figure.png){#fig-lattice}",
  "",
  "The figure @fig-lattice shows the roots that @Nik80 classifies.",
  "",
].join("\n");

/** The sections of the open hover tooltips that the reference preview does not fill. */
async function otherHoverSections(page: Page): Promise<string[]> {
  return await page
    .locator(".cm-tooltip-hover .cm-tooltip-section:not(.reference-hover-preview)")
    .allTextContents();
}

describe("assembled app: the hover of a cross-reference and of a citation", function () {
  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let page: Page | undefined;
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-cross-reference-hover-e2e-", {
      documentName: "lattices.md",
      documentContents: DOCUMENT,
      // Source text, so that the hover targets are the authored characters.
      config: { display: { renderingMode: "raw" } },
    });
    fixtureRoot = fixture.root;
    const libraryPath = path.join(fixture.root, "references.bib");
    await writeFile(libraryPath, LIBRARY, "utf8");
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.export = { ...(config.export as Record<string, unknown>), cslLibrary: libraryPath };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    app = await attach(fixture.configDirectory, rendererEvents);
    page = await findEditorPage(app.browser, 60_000);
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
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(output);
  });

  it("shows only the figure in the hover of a cross-reference", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "@fig-lattice");
    await editor.locator(".reference-hover-preview").waitFor({ state: "visible", timeout: 20_000 });
    // Each hover source of the editor waits 500 ms after the same mouse
    // move; a second tooltip opens with the reference preview or not at all.
    await editor.waitForTimeout(1_000);
    screenshots.set("cross-reference-hover.png", await editor.screenshot());
    assert.deepEqual(
      await otherHoverSections(editor),
      [],
      "the hover of a cross-reference holds no citation tooltip",
    );
  });

  it("shows the bibliography entry in the hover of a citation", async function () {
    const editor = requireInitialized(page, "editor page");
    await editor.mouse.move(5, 5);
    await editor.locator(".cm-tooltip-hover").waitFor({ state: "detached", timeout: 20_000 });
    await hoverText(editor, "@Nik80");
    const entry = editor.locator(".cm-tooltip-hover .csl-entry");
    await entry.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("citation-hover.png", await editor.screenshot());
    assert.match(
      await entry.innerText(),
      /^Nikulin, V\. V\. 1980\. .Integral Symmetric Bilinear Forms/,
    );
  });
});

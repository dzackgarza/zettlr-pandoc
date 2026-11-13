/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A preview whose citation cannot be rendered
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the assembled app with `export.cslStyle` at a file
 *                  that is absent, so each render of a citation fails (§12).
 *                  The preview of a cross-reference, of a footnote and of a
 *                  wikilink holds a citation. Each preview shows its source
 *                  text and the cause of the failure (#92).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { hoverText } from "./support/editor-hover";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-preview-citation-failure-e2e-latest");

const LIBRARY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;

const DOCUMENT = [
  "# Fibers",
  "",
  "::: {#thm-reduction}",
  "A curve has stable reduction after a base change [@AW71].",
  ":::",
  "",
  "By @thm-reduction the fibers are known.[^1] See [[curves]].",
  "",
  "[^1]: The degenerate fibers are listed in [@AW71].",
  "",
].join("\n");

const LINKED_DOCUMENT = "# Curves\n\nThe stable models of curves are in [@AW71].\n";

/** The message of the failure that a read of this absent file gives. */
async function readFailure(file: string): Promise<string> {
  const error: Error = await readFile(file, "utf8").then(
    () => new Error(`${file} is readable`),
    (cause: Error) => cause,
  );
  return error.message;
}

/** The text of a preview once it holds a text, collapsed to single spaces. */
async function previewText(page: Page, selector: string, holding: string): Promise<string> {
  const preview = page.locator(selector).first();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await preview.count()) > 0) {
      const text = (await preview.innerText()).replace(/\s+/g, " ").trim();
      if (text.includes(holding)) {
        return text;
      }
    }
    await delay(100);
  }
  return (await preview.count()) > 0 ? (await preview.innerText()).replace(/\s+/g, " ") : "";
}

describe("assembled app: a preview whose citation cannot be rendered", function () {
  this.timeout(300_000);

  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let page: Page | undefined;
  let resources = "";
  let failure = "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    resources = await mkdtemp(path.join(tmpdir(), "zettlr-preview-citation-resources-"));
    const library = path.join(resources, "references.bib");
    await writeFile(library, LIBRARY);
    const missingStyle = path.join(resources, "unmounted", "journal.csl");
    failure = `The citation style ${missingStyle} could not be loaded: ${await readFailure(missingStyle)}`;

    const fixture = await createFixture("zettlr-preview-citation-failure-e2e-", {
      documentName: "fibers.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: false,
        // Source text, so that the hover targets are the authored characters.
        display: { renderingMode: "raw" },
        export: { cslLibrary: library, cslStyle: missingStyle },
      },
    });
    fixtureRoot = fixture.root;
    await writeFile(path.join(path.dirname(fixture.documentPath), "curves.md"), LINKED_DOCUMENT);
    app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    page = await findEditorPage(app.browser, 60_000);
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: 60_000 });
  });

  afterEach(async function () {
    const editor = requireInitialized(page, "editor page");
    await editor.mouse.move(5, 5);
    await editor.locator(".cm-tooltip-hover").waitFor({ state: "detached", timeout: 20_000 });
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
    await rm(resources, { recursive: true, force: true });
    assertCleanExit(output);
  });

  it("the preview of a cross-reference shows its source and the cause", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "@thm-reduction");
    const text = await previewText(editor, "[data-reference-excerpt]", failure);
    screenshots.set("cross-reference-preview.png", await editor.screenshot());
    assert.ok(
      text.includes("A curve has stable reduction after a base change [@AW71]."),
      `the preview shows the source: ${text}`,
    );
    assert.ok(text.includes(failure), `the preview names the cause: ${text}`);
  });

  it("the preview of a footnote shows its source and the cause", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "[^1]");
    const text = await previewText(editor, ".footnote-preview-container", failure);
    screenshots.set("footnote-preview.png", await editor.screenshot());
    assert.ok(
      text.includes("The degenerate fibers are listed in [@AW71]."),
      `the preview shows the source: ${text}`,
    );
    assert.ok(text.includes(failure), `the preview names the cause: ${text}`);
  });

  it("the preview of a wikilink shows its source and the cause", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "[[curves]]");
    const text = await previewText(editor, ".editor-note-preview .note-content", failure);
    screenshots.set("wikilink-preview.png", await editor.screenshot());
    assert.ok(
      text.includes("The stable models of curves are in [@AW71]."),
      `the preview shows the source: ${text}`,
    );
    assert.ok(text.includes(failure), `the preview names the cause: ${text}`);
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The hover preview of a citation whose key the library
 *                  does not hold
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the assembled app with a library of one entry. The
 *                  hover preview of a citation of that entry shows the
 *                  entry. The hover preview of a citation whose key the
 *                  library does not hold says so; the main process answers
 *                  that request with no bibliography, and the preview reads
 *                  that answer as the contract declares it.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  preserveArtifacts,
  type RunningApp,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-citation-tooltip-unknown-key-e2e-latest");

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
  "The fibers are listed in [@AW71].",
  "",
  "The reduction is in [@Unknown1999].",
  "",
].join("\n");

const NO_ENTRY = "The library holds no entry of this citation, or the library is not loaded.";

/** The text of the hover preview once it is not the loading text. */
async function tooltipText(page: Page): Promise<string> {
  const tooltip = page.locator(".cm-tooltip-hover").first();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await tooltip.count()) > 0) {
      const text = (await tooltip.innerText()).replace(/\s+/g, " ").trim();
      if (text !== "" && text !== "Loading…") {
        return text;
      }
    }
    await delay(100);
  }
  return (await tooltip.count()) > 0 ? (await tooltip.innerText()).trim() : "";
}

describe("assembled app: the hover preview of a citation", function () {
  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let page: Page | undefined;
  let resources = "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    resources = await mkdtemp(path.join(tmpdir(), "zettlr-citation-tooltip-resources-"));
    const library = path.join(resources, "references.bib");
    await writeFile(library, LIBRARY);
    const fixture = await createFixture("zettlr-citation-tooltip-unknown-key-e2e-", {
      documentName: "fibers.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: false,
        // Source text, so that the hover targets are the authored characters.
        display: { renderingMode: "raw" },
        export: { cslLibrary: library },
      },
    });
    fixtureRoot = fixture.root;
    app = await attach(fixture.configDirectory, rendererEvents);
    page = await findEditorPage(app.browser, 60_000);
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

  it("shows the entry of a key that the library holds", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "@AW71");
    const text = await tooltipText(editor);
    screenshots.set("known-key.png", await editor.screenshot());
    assert.ok(text.includes("Degenerate"), `the preview shows the entry: ${text}`);
  });

  it("says that the library holds no entry of a key that it does not hold", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "@Unknown1999");
    const text = await tooltipText(editor);
    screenshots.set("unknown-key.png", await editor.screenshot());
    assert.equal(text, NO_ENTRY);
  });
});

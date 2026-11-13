/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The images of the hover previews of the editor
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A hover over a figure reference shows the excerpt of the
 *                  figure, and a hover over a footnote shows its text. An
 *                  image of that excerpt or text has a path relative to the
 *                  folder of its document; the preview shows the image, as
 *                  the editor and the print window do.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { hoverText } from "./support/editor-hover";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  REPO_ROOT,
  type RunningApp,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-preview-image-paths-e2e-latest");

/** A 12 x 12 PNG; the preview loads it from the folder of the document. */
const FIGURE = path.join(REPO_ROOT, "test/fixtures/quarto-book/foundations/figure.png");

const DOCUMENT = [
  "# Lattices",
  "",
  "![The E8 root lattice](figure.png){#fig-lattice}",
  "",
  "The figure @fig-lattice shows the roots.",
  "",
  "A footnote holds the same figure.[^roots]",
  "",
  "[^roots]: ![The roots again](figure.png)",
  "",
].join("\n");

/** Whether the image of a preview loaded: a broken image has no natural width. */
async function loadedImage(preview: Locator): Promise<{ src: string; width: number }> {
  const image = preview.locator("img").first();
  await image.waitFor({ state: "attached", timeout: 20_000 });
  await image.evaluate(
    async (element) =>
      await new Promise<void>((resolve) => {
        const img = element as HTMLImageElement;
        if (img.complete) {
          resolve();
          return;
        }
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      }),
  );
  return await image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return { src: img.src, width: img.naturalWidth };
  });
}

describe("assembled app: images in hover previews", function () {
  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let page: Page | undefined;
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-preview-image-paths-e2e-", {
      documentName: "lattices.md",
      documentContents: DOCUMENT,
      // Source text, so that the hover targets are the authored characters.
      config: { display: { renderingMode: "raw" } },
    });
    fixtureRoot = fixture.root;
    await copyFile(FIGURE, path.join(path.dirname(fixture.documentPath), "figure.png"));
    app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    page = await findEditorPage(app.browser, 60_000);
    await hideDevServerOverlay(page);
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

  it("shows the figure in the hover of its reference", async function () {
    const editor = requireInitialized(page, "editor page");
    await hoverText(editor, "@fig-lattice");
    const preview = editor.locator(".reference-hover-excerpt");
    await preview.waitFor({ state: "visible", timeout: 20_000 });
    const image = await loadedImage(preview);
    screenshots.set("reference-hover.png", await editor.screenshot());
    assert.ok(image.width > 0, `The figure of the hover loads; its source is ${image.src}`);
  });

  it("shows the figure in the hover of a footnote", async function () {
    const editor = requireInitialized(page, "editor page");
    await editor.mouse.move(5, 5);
    await hoverText(editor, "[^roots]");
    const preview = editor.locator(".footnote-preview-container");
    await preview.waitFor({ state: "visible", timeout: 20_000 });
    const image = await loadedImage(preview);
    screenshots.set("footnote-hover.png", await editor.screenshot());
    assert.ok(image.width > 0, `The figure of the footnote loads; its source is ${image.src}`);
  });
});

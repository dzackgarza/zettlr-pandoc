/**
 * Assembled-app proof that a wikilink of the format `title|link`
 * (`zkn.linkFormat`) has one target in every part of the application: the
 * editor draws it as a chip of its document, and a directory rename rewrites
 * it (#203).
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { answerPreview, textOnceItIs } from "./support/workspace-edit-preview";

const INDEX = "# Index\n\nSee [[the lattices|old/lattices]].\n";

describe("assembled app: wikilinks of the format title|link", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-wikilinks-title-first-e2e-", {
      documentName: "index.md",
      documentContents: INDEX,
      config: { darkMode: false, zkn: { linkFormat: "title|link" } },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    await mkdir(path.join(workspace, "old"));
    await writeFile(path.join(workspace, "old", "lattices.md"), "# Lattices\n", "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-wikilinks-title-first-e2e-latest"),
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

  it("draws the link as a chip of the document after the pipe", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    // The cursor on the heading leaves the link line rendered
    await page.locator(".cm-line", { hasText: "Index" }).first().click();

    const chips = page.locator(".wikilink-chip");
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      !isDeepStrictEqual(await chips.allTextContents(), ["the lattices"])
    ) {
      await delay(100);
    }
    screenshots.set("chip.png", await page.screenshot());
    assert.deepEqual(await chips.allTextContents(), ["the lattices"]);
    assert.equal(
      await chips.first().getAttribute("title"),
      path.join(workspace, "old", "lattices.md"),
    );
  });

  it("rewrites the link part when a directory rename moves its document", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const renamed = await page.evaluate(
      async (payload) => await window.ipc.invoke("application", { command: "dir-rename", payload }),
      { path: path.join(workspace, "old"), name: "algebra" },
    );
    assert.equal(renamed, true);
    await answerPreview(page, "apply");

    const index = "# Index\n\nSee [[the lattices|lattices]].\n";
    assert.equal(await textOnceItIs(path.join(workspace, "index.md"), index), index);
  });
});

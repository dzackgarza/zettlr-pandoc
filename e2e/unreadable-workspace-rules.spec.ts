/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a workspace whose file filters cannot be read
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author has two workspaces. The `.zettlrignore` of one
 *                  of them cannot be read when the application starts, so
 *                  the application does not know which of its files the
 *                  author hid. The file manager lists the other workspace
 *                  with its files and this one with the cause and no files.
 *                  "Check for directory …" loads the workspace with its rules
 *                  when the file can be read again.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-unreadable-workspace-rules-e2e-latest");

describe("a workspace whose file filters cannot be read", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notes = "";
  let rulesFile = "";
  let lattice = "";
  let scratch = "";
  let genus = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-unreadable-workspace-rules-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: {
        darkMode: false,
        fileManagerMode: "combined",
        window: { fileManagerVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    genus = fixture.documentPath;
    notes = path.join(fixture.root, "notes");
    rulesFile = path.join(notes, ".zettlrignore");
    lattice = path.join(notes, "lattice.md");
    scratch = path.join(notes, "scratch.md");
    await mkdir(notes);
    await writeFile(lattice, "# Lattice\n\nAn even unimodular lattice.\n", "utf8");
    await writeFile(scratch, "# Scratch\n\nA computation the author hid.\n", "utf8");
    await writeFile(rulesFile, "scratch.md\n", "utf8");
    await chmod(rulesFile, 0o000);

    const configPath = path.join(fixture.configDirectory, "config.json");
    const config: { app: { openWorkspaces: string[] } } = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    config.app.openWorkspaces = [path.dirname(fixture.documentPath), notes];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
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
      await chmod(rulesFile, 0o644);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  function workspaceRow(activePage: Page) {
    return activePage.locator(`.tree-item.directory[data-path=${JSON.stringify(notes)}]`);
  }

  function fileRow(activePage: Page, filePath: string) {
    return activePage.locator(`.tree-item.file[data-path=${JSON.stringify(filePath)}]`);
  }

  it("lists the other workspace with its files and names the rules file of this one", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await fileRow(activePage, genus).waitFor({ state: "visible", timeout: 30_000 });
    const row = workspaceRow(activePage);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("rules-unreadable.png", await activePage.screenshot());

    assert.equal(await row.getAttribute("data-metadata-problem"), "rules");
    assert.ok(
      (await row.locator(".display-text").getAttribute("title"))?.includes(rulesFile),
      "the row names the rules file",
    );
    assert.equal(
      await fileRow(activePage, lattice).count(),
      0,
      "no file of the workspace is listed",
    );
    assert.equal(
      await fileRow(activePage, scratch).count(),
      0,
      "no file of the workspace is listed",
    );
  });

  it("loads the workspace with its rules when the file can be read", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await chmod(rulesFile, 0o644);

    await workspaceRow(activePage).locator(".display-text").click({ button: "right" });
    const item = activePage
      .locator('.application-menu .menu-item[data-id="menu.rescan_dir"]')
      .last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();

    await workspaceRow(activePage).locator(".item-icon cds-icon").click();
    await fileRow(activePage, lattice).waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("rules-loaded.png", await activePage.screenshot());

    assert.equal(await workspaceRow(activePage).getAttribute("data-metadata-problem"), null);
    assert.equal(await fileRow(activePage, scratch).count(), 0, "the rule hides scratch.md");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a workspace whose folder is missing
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author has a workspace on a drive that is not mounted
 *                  when the application starts. The file manager lists the
 *                  workspace as missing. "Check for directory …" in its
 *                  context menu names the folder and the cause while the
 *                  folder is absent, and loads the workspace with its files
 *                  when the folder is back.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-missing-workspace-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

describe("a workspace whose folder is missing", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let drive = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-missing-workspace-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: {
        darkMode: false,
        fileManagerMode: "combined",
        window: { fileManagerVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    drive = path.join(fixture.root, "drive");

    const configPath = path.join(fixture.configDirectory, "config.json");
    const config: { app: { openWorkspaces: string[] } } = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    config.app.openWorkspaces = [path.dirname(fixture.documentPath), drive];
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
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  function workspaceRow(activePage: Page) {
    return activePage.locator(`.tree-item.directory[data-path=${JSON.stringify(drive)}]`);
  }

  async function checkForDirectory(activePage: Page): Promise<void> {
    await workspaceRow(activePage).locator(".display-text").click({ button: "right" });
    const item = activePage
      .locator('.application-menu .menu-item[data-id="menu.rescan_dir"]')
      .last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();
  }

  it("lists the workspace as missing", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await workspaceRow(activePage).waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("missing-workspace.png", await activePage.screenshot());
  });

  it("names the folder when it is still missing", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await checkForDirectory(activePage);
    const toast = activePage.locator(ERROR_TOAST).last();
    await toast.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("still-missing.png", await activePage.screenshot());
    assert.ok(
      (await toast.textContent())?.includes(drive),
      "the message names the folder of the workspace",
    );
  });

  it("loads the workspace with its files when the folder is back", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await mkdir(drive);
    const note = path.join(drive, "lattice.md");
    await writeFile(note, "# Lattice\n\nAn even unimodular lattice.\n", "utf8");

    await checkForDirectory(activePage);
    await workspaceRow(activePage).locator(".item-icon cds-icon").click();
    await activePage
      .locator(`.tree-item.file[data-path=${JSON.stringify(note)}]`)
      .waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("loaded-workspace.png", await activePage.screenshot());
  });
});

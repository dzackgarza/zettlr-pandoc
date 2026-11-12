/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of the metadata-field sort of a folder
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author has two workspaces open and a document of one of
 *                  them in the editor. A subfolder of the other workspace sorts
 *                  its notes by the front matter field `date`. Each control that changes
 *                  the order of a folder changes the folder that the author
 *                  names: the context menu of the folder, the Properties of
 *                  the folder, and the Workspaces menu, which names the folder
 *                  it changes. The Properties show the metadata sort of the
 *                  folder and reverse it without a change of its field.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-explorer-metadata-sort-e2e-latest");

/**
 * Conversation notes whose names and dates are in different orders. The dates
 * have the two forms that the YAML of an export has: a quoted timestamp with
 * an offset, and a plain date and time.
 */
const NOTES = [
  { name: "alpha.md", title: "Reflection groups", date: "'2025-03-14T09:30:00+08:00'" },
  { name: "beta.md", title: "Hyperbolic lattices", date: "'2023-11-02T18:05:00+08:00'" },
  { name: "gamma.md", title: "Coxeter diagrams", date: "2024-06-21 12:00:00" },
  { name: "delta.md", title: "Vinberg's algorithm", date: "'2026-01-08T07:45:00+08:00'" },
];
const OLDEST_FIRST = ["beta.md", "gamma.md", "alpha.md", "delta.md"];
const NEWEST_FIRST = [...OLDEST_FIRST].reverse();

/** The settings file of a folder whose notes sort by their date. */
const DATE_SORTED_SETTINGS = {
  sorting: "frontmatter-up",
  explorer: {
    displayName: "inherit",
    sortMetadataKey: "date",
    foldersFirst: null,
    projectFilter: "all",
  },
  project: null,
  icon: null,
  color: null,
  quartoManifest: null,
};

interface StoredSettings {
  sorting: string;
  explorer: { sortMetadataKey: string };
}

describe("the metadata-field sort of a folder", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notesWorkspace = "";
  let archive = "";
  let conversations = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-explorer-metadata-sort-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: {
        darkMode: false,
        fileManagerMode: "combined",
        fileNameDisplay: "title+heading",
        sorting: "natural",
        sortFoldersFirst: true,
        window: { fileManagerVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    notesWorkspace = path.dirname(fixture.documentPath);
    archive = path.join(fixture.root, "archive");
    conversations = path.join(archive, "conversations");
    await mkdir(conversations, { recursive: true });
    for (const entry of NOTES) {
      await writeFile(
        path.join(conversations, entry.name),
        `---\ntitle: ${entry.title}\ndate: ${entry.date}\n---\n\n# ${entry.title}\n\nNotes.\n`,
        "utf8",
      );
    }
    await writeFile(
      path.join(conversations, ".ztr-directory"),
      `${JSON.stringify(DATE_SORTED_SETTINGS)}\n`,
      "utf8",
    );

    // Two workspaces; the document in the editor and the selected folder are
    // those of the notes workspace. The notes are in a subfolder of the other.
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config: { app: { openWorkspaces: string[] }; openDirectory: string | null } = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    config.app.openWorkspaces = [notesWorkspace, archive];
    config.openDirectory = notesWorkspace;
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

  function folderRow(activePage: Page, folder: string) {
    return activePage.locator(`.tree-item.directory[data-path=${JSON.stringify(folder)}]`);
  }

  /** The names of the note rows of the conversations folder, in the order shown. */
  async function shownOrder(activePage: Page): Promise<string[]> {
    const rows = activePage.locator(
      `.tree-item.file[data-path^=${JSON.stringify(`${conversations}${path.sep}`)}]`,
    );
    const paths = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        // The selector holds only rows with the attribute.
        const rowPath = element.getAttribute("data-path");
        if (rowPath === null) {
          throw new Error("A row of the selector has no data-path");
        }
        return rowPath;
      }),
    );
    return paths.map((entry) => path.basename(entry));
  }

  /** Waits until the file manager shows the expected order. */
  async function waitForOrder(activePage: Page, expected: string[]): Promise<void> {
    const deadline = Date.now() + 10_000;
    let shown = await shownOrder(activePage);
    while (JSON.stringify(shown) !== JSON.stringify(expected) && Date.now() < deadline) {
      await delay(100);
      shown = await shownOrder(activePage);
    }
    assert.deepEqual(shown, expected);
  }

  async function storedSettings(folder: string): Promise<StoredSettings> {
    return JSON.parse(await readFile(path.join(folder, ".ztr-directory"), "utf8"));
  }

  /**
   * Waits until the settings file of a folder holds a sort. The window shows
   * a new order before the main process has written the file.
   */
  async function waitForStoredSorting(folder: string, sorting: string): Promise<StoredSettings> {
    const deadline = Date.now() + 10_000;
    let stored = await storedSettings(folder);
    while (stored.sorting !== sorting && Date.now() < deadline) {
      await delay(100);
      stored = await storedSettings(folder);
    }
    assert.equal(stored.sorting, sorting);
    return stored;
  }

  /** Chooses an item of a submenu of the menu that is open. */
  async function chooseMenuItem(
    activePage: Page,
    submenuId: string,
    itemId: string,
  ): Promise<void> {
    const submenu = activePage
      .locator(`.application-menu .menu-item[data-id=${JSON.stringify(submenuId)}]`)
      .last();
    await submenu.waitFor({ state: "visible", timeout: 10_000 });
    await submenu.hover();
    const item = activePage
      .locator(`.application-menu .menu-item[data-id=${JSON.stringify(itemId)}]`)
      .last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();
  }

  it("shows the notes of the folder in the order of their dates", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    for (const folder of [archive, conversations]) {
      const arrow = folderRow(activePage, folder).locator(".item-icon cds-icon").first();
      await arrow.waitFor({ state: "visible", timeout: 30_000 });
      await arrow.click();
    }
    await waitForOrder(activePage, OLDEST_FIRST);
  });

  it("reverses a folder from the context menu of that folder", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await folderRow(activePage, conversations).locator(".display-text").click({ button: "right" });
    await chooseMenuItem(activePage, "explorer-direction", "explorer-direction-down");
    await waitForOrder(activePage, NEWEST_FIRST);
    screenshots.set("context-menu-descending.png", await activePage.screenshot());

    const stored = await waitForStoredSorting(conversations, "frontmatter-down");
    assert.equal(stored.explorer.sortMetadataKey, "date");
    await assert.rejects(
      access(path.join(notesWorkspace, ".ztr-directory")),
      "the folder that the author did not name keeps its settings",
    );
  });

  it("shows the metadata sort in the Properties and reverses it there", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await folderRow(activePage, conversations).locator(".display-text").click({ button: "right" });
    const properties = activePage
      .locator('.application-menu .menu-item[data-id="menu.properties"]')
      .last();
    await properties.waitFor({ state: "visible", timeout: 10_000 });
    await properties.click();

    const [sortControl, directionControl] = [
      activePage.locator("#dir-props select").nth(0),
      activePage.locator("#dir-props select").nth(1),
    ];
    await directionControl.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("properties-descending.png", await activePage.screenshot());
    assert.equal(await sortControl.inputValue(), "metadata");
    assert.equal(await directionControl.inputValue(), "down");

    await directionControl.selectOption("up");
    await waitForOrder(activePage, OLDEST_FIRST);
    const stored = await waitForStoredSorting(conversations, "frontmatter-up");
    assert.equal(stored.explorer.sortMetadataKey, "date");
    await activePage.keyboard.press("Escape");
  });

  it("reverses the selected folder from the Workspaces menu and names it", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The document in the editor belongs to the other workspace, and the
    // selected folder is a subfolder of a workspace.
    await folderRow(activePage, conversations).locator(".display-text").click();
    await activePage.locator("#directories-dirs-header .root-settings").click();
    const target = activePage
      .locator('.application-menu .menu-item[data-id="explorer-target"] .label')
      .last();
    await target.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("workspaces-menu-choice.png", await activePage.screenshot());
    await chooseMenuItem(activePage, "explorer-direction", "explorer-direction-down");
    await waitForOrder(activePage, NEWEST_FIRST);
    await waitForStoredSorting(conversations, "frontmatter-down");
    for (const folder of [notesWorkspace, archive]) {
      await assert.rejects(
        access(path.join(folder, ".ztr-directory")),
        "a folder that the author did not select keeps its settings",
      );
    }

    await activePage.locator("#directories-dirs-header .root-settings").click();
    await target.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("workspaces-menu.png", await activePage.screenshot());
    assert.ok(
      (await target.textContent())?.includes(path.basename(conversations)),
      "the menu names the selected folder",
    );
    await activePage.keyboard.press("Escape");
  });
});

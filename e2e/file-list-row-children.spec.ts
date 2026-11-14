/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Children of a row of the file list E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The list keeps its rows while the folder that it shows
 *                  changes: a row gets the item of another path. A row of
 *                  a file asks the filesystem for no children when a file
 *                  of a folder changes that the row showed before, and the
 *                  row of a folder shows the counts of the children of
 *                  that folder.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  type Fixture,
  findEditorPage,
  readAppLog,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const GENERA = ["definite", "indefinite", "unimodular"];
const LATTICES = ["d16.md", "e8.md", "leech.md"];

describe("Children of a row of the file list", function () {
  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let fixture: Fixture | undefined;
  let genera = "";
  let lattices = "";

  before(async function () {
    fixture = await createFixture("zettlr-file-list-row-children-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
      config: {
        fileManagerMode: "expanded",
        fileMeta: true,
      },
    });
    const workspace = path.dirname(fixture.documentPath);
    // The two folders have the same number of rows in the list: the folder
    // and three children. Each row that the list made for a folder of
    // `genera` shows a path of `lattices` afterwards.
    genera = path.join(workspace, "genera");
    lattices = path.join(workspace, "lattices");
    for (const genus of GENERA) {
      await mkdir(path.join(genera, genus), { recursive: true });
    }
    await mkdir(lattices);
    for (const lattice of LATTICES) {
      await writeFile(path.join(lattices, lattice), "# A lattice\n\nOne lattice.\n");
    }
    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, []));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  /**
   * The row of `itemPath` that the list shows. The scroller of the list
   * keeps the rows that it does not use, hidden, with the item that each
   * one showed last.
   */
  function listedRow(itemPath: string): Locator {
    return requireInitialized(page, "The editor page must be initialized")
      .locator(`#file-list .list-item[data-path=${JSON.stringify(itemPath)}]`)
      .filter({ visible: true });
  }

  /** Show `folder` in the list. */
  async function showInList(folder: string): Promise<void> {
    await requireInitialized(page, "The editor page must be initialized")
      .locator(`#file-tree [data-path=${JSON.stringify(folder)}]`)
      .first()
      .click();
    await listedRow(folder).waitFor({ state: "visible" });
  }

  /** The count badges of the row of `folder`, which the list shows. */
  async function countsOfListedFolder(folder: string, expected: string[]): Promise<string[]> {
    const badges = listedRow(folder).locator(".meta-info .badge");
    const deadline = Date.now() + 5_000;
    let counts = (await badges.allTextContents()).map((text) => text.trim()).slice(0, 2);
    while (counts.join("|") !== expected.join("|") && Date.now() < deadline) {
      await delay(100);
      counts = (await badges.allTextContents()).map((text) => text.trim()).slice(0, 2);
    }
    return counts;
  }

  it("a changed folder asks no row of a file for children", async function () {
    const root = requireInitialized(fixture, "The fixture must be initialized").root;
    await showInList(genera);
    for (const genus of GENERA) {
      await listedRow(path.join(genera, genus)).waitFor({ state: "visible" });
    }
    await showInList(lattices);
    for (const lattice of LATTICES) {
      await listedRow(path.join(lattices, lattice)).waitFor({ state: "visible" });
    }

    // A change in each folder that a row of the list showed before.
    await writeFile(path.join(genera, "classes.md"), "# Classes\n\nThe classes of a genus.\n");
    for (const genus of GENERA) {
      await writeFile(path.join(genera, genus, "example.md"), "# Example\n\nOne example.\n");
    }
    // The watcher reports the changes in their order: the row of this file
    // is there after the app handled the changes before it.
    const niemeier = path.join(lattices, "niemeier.md");
    await writeFile(niemeier, "# Niemeier\n\nA Niemeier lattice.\n");
    await listedRow(niemeier).waitFor({ state: "visible" });
    // The log request of a window arrives after the row of the new file.
    await delay(1_000);

    const refusals = (await readAppLog(root))
      .split("\n")
      .filter((line) => line.includes("Could not fetch children"));
    assert.deepEqual(refusals, [], "no row asked a file for its children");
  });

  it("the row of a folder shows the counts of that folder", async function () {
    await showInList(lattices);
    assert.deepEqual(
      await countsOfListedFolder(lattices, ["0 Directories", "4 Files"]),
      ["0 Directories", "4 Files"],
      "the folder of the lattices holds four files",
    );
    await showInList(genera);
    assert.deepEqual(
      await countsOfListedFolder(genera, ["3 Directories", "1 Files"]),
      ["3 Directories", "1 Files"],
      "the folder of the genera holds three folders and one file",
    );
  });
});

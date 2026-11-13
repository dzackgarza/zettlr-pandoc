/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        New file and new folder from the file list E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "New file" and "New directory" of the context menu of a
 *                  folder are one action in the tree and in the file list
 *                  (#202): a name field opens under the folder, and Enter
 *                  makes the file or the folder with the name of the field.
 *                  A field stays with its row while the rows of the list
 *                  change, and the rename field of a row renames its file.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

/** The names in `directory`, once they hold `name` or after ten seconds. */
async function namesOnceHolding(directory: string, name: string): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  let names = await readdir(directory);
  while (!names.includes(name) && Date.now() < deadline) {
    await delay(100);
    names = await readdir(directory);
  }
  return names.sort();
}

describe("New file and new folder from the file list (#202)", function () {
  this.timeout(120_000);

  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let workspace = "";
  let lattices = "";

  before(async function () {
    const fixture = await createFixture("zettlr-file-list-create-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
      config: {
        fileManagerMode: "expanded",
      },
    });
    workspace = path.dirname(fixture.documentPath);
    lattices = path.join(workspace, "lattices");
    await mkdir(lattices);
    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, []));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  /** Open the name field of `itemId` on the row of `lattices` in the list. */
  async function openNameField(itemId: string): Promise<Locator> {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The list shows the folder that the tree selects; a new folder
    // selects itself.
    await activePage
      .locator(`#file-tree [data-path=${JSON.stringify(workspace)}]`)
      .first()
      .click();
    const row = activePage.locator(`#file-list .list-item[data-path=${JSON.stringify(lattices)}]`);
    await row.waitFor({ state: "visible" });
    const before = await readdir(lattices);
    await row.click({ button: "right" });
    await activePage.locator(`.application-menu .menu-item[data-id="${itemId}"]`).click();
    const field = activePage.locator("#file-list input.filename-input");
    const deadline = Date.now() + 5_000;
    while (
      (await field.count()) === 0 &&
      (await readdir(lattices)).length === before.length &&
      Date.now() < deadline
    ) {
      await delay(100);
    }
    assert.equal(
      await field.count(),
      1,
      `the list asks for the name; the folder holds ${JSON.stringify(await readdir(lattices))}`,
    );
    return field;
  }

  /**
   * Create `name` in `lattices` and wait for the end of the command: the
   * command selects a new folder (`dir-new`) and opens a new file in an active
   * tab (`file-new`) after it writes to the disk. A test that starts before
   * that end gets the selection of the command after its own.
   */
  async function createFromList(itemId: "menu.new_dir" | "menu.new_file", name: string) {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const field = await openNameField(itemId);
    await field.fill(name);
    await field.press("Enter");
    const end =
      itemId === "menu.new_dir"
        ? `#file-tree .tree-item.selected[data-path=${JSON.stringify(path.join(lattices, name))}]`
        : `[role="tab"].active[data-path=${JSON.stringify(path.join(lattices, `${name}.md`))}]`;
    await activePage.locator(end).waitFor({ state: "attached" });
  }

  it("New directory asks for the name of the folder", async function () {
    await createFromList("menu.new_dir", "Genera");
    assert.deepEqual(await namesOnceHolding(lattices, "Genera"), ["Genera"]);
  });

  it("New file asks for the name of the file in the list", async function () {
    await createFromList("menu.new_file", "discriminant-form");
    assert.deepEqual(await namesOnceHolding(lattices, "discriminant-form.md"), [
      "Genera",
      "discriminant-form.md",
    ]);
  });

  it("the name field stays open while the rows of the list change", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const field = await openNameField("menu.new_dir");
    await field.pressSequentially("Gen");
    // Another program adds a file that sorts before the folder.
    const basis = path.join(workspace, "a-basis.md");
    await writeFile(basis, "# Basis\n");
    await activePage
      .locator(`#file-list .list-item[data-path=${JSON.stringify(basis)}]`)
      .waitFor({ state: "visible" });
    await delay(500);
    assert.equal(await field.count(), 1, "the field is open");
    await field.pressSequentially("us");
    await field.press("Enter");
    const genus = path.join(lattices, "Genus");
    await activePage
      .locator(`#file-tree .tree-item.selected[data-path=${JSON.stringify(genus)}]`)
      .waitFor({ state: "attached" });
    assert.deepEqual(await namesOnceHolding(lattices, "Genus"), [
      "Genera",
      "Genus",
      "discriminant-form.md",
    ]);
  });

  it("Rename in the list renames the file of the row", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const form = path.join(lattices, "discriminant-form.md");
    await activePage
      .locator(`#file-tree [data-path=${JSON.stringify(lattices)}]`)
      .first()
      .click();
    const row = activePage.locator(`#file-list .list-item[data-path=${JSON.stringify(form)}]`);
    await row.click({ button: "right" });
    await activePage.locator('.application-menu .menu-item[data-id="menu.rename_file"]').click();
    const field = row.locator("input");
    await field.waitFor({ state: "visible" });
    assert.equal(await field.inputValue(), "discriminant-form.md", "the field holds the name");
    await field.fill("quadratic-form.md");
    await field.press("Enter");
    assert.deepEqual(await namesOnceHolding(lattices, "quadratic-form.md"), [
      "Genera",
      "Genus",
      "quadratic-form.md",
    ]);
  });
});

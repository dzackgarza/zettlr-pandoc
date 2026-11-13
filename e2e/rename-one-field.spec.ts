/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Rename from the key and from the menu of a row (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A rename is one action (#202). The context menu of a row
 *                  shows the key of "Rename file" and opens the name field
 *                  of that row; the key renames the active document in the
 *                  same field of its row. A document whose row the file
 *                  manager does not show asks for the name under its tab.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { pressKey, windowOfPage } from "./support/native-dialog";

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

describe("Rename from the key and from the menu of a row (#202)", function () {
  this.timeout(120_000);

  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let workspace = "";
  let lattices = "";

  before(async function () {
    assert.equal(process.env.DISPLAY !== undefined, true, "the run has a display");
    const fixture = await createFixture("zettlr-rename-one-field-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
      config: { fileManagerMode: "combined" },
    });
    workspace = path.dirname(fixture.documentPath);
    lattices = path.join(workspace, "lattices");
    await mkdir(lattices);
    await writeFile(path.join(lattices, "form.md"), "# Form\n");
    ({ browser, appProcess, getOutput } = await attach(
      fixture.configDirectory,
      [],
      this.timeout(),
    ));
    page = await findEditorPage(browser, this.timeout());
    await hideDevServerOverlay(page);
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  /** Open `file` from its row and give the editor the focus. */
  async function openFromRow(activePage: Page, file: string): Promise<void> {
    await activePage
      .locator(`#file-tree [data-path=${JSON.stringify(file)}]`)
      .first()
      .click();
    await activePage.locator(`[role="tab"][data-path=${JSON.stringify(file)}]`).waitFor();
    await activePage.locator(".main-editor-wrapper .cm-content:visible").click();
  }

  it("the key renames the active document in the name field of its row", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const genus = path.join(workspace, "genus.md");
    await openFromRow(activePage, genus);
    const row = activePage.locator(`#file-tree [data-path=${JSON.stringify(genus)}]`).first();
    const menu = activePage.locator('.application-menu .menu-item[data-id="menu.rename_file"]');
    await row.click({ button: "right" });
    const shownKey = (await menu.innerText()).replace(/\s+/g, " ");
    await activePage.keyboard.press("Escape");
    await activePage.locator(".main-editor-wrapper .cm-content:visible").click();

    await pressKey(await windowOfPage(activePage), "ctrl+r");
    const field = row.locator("input.filename-input");
    const popup = activePage.locator(".file-rename input");
    const deadline = Date.now() + 5_000;
    while ((await field.count()) + (await popup.count()) === 0 && Date.now() < deadline) {
      await delay(100);
    }
    assert.deepEqual(
      {
        shownKey: /Ctrl\s*\+?\s*R|⌃\s*R/i.test(shownKey),
        rowField: await field.count(),
        tabPopup: await popup.count(),
      },
      { shownKey: true, rowField: 1, tabPopup: 0 },
      `the menu of the row shows "${shownKey}"; the key opens the field of the row`,
    );
    assert.equal(await field.inputValue(), "genus.md", "the field holds the name");
    await field.fill("quadratic-form.md");
    await field.press("Enter");
    assert.deepEqual(await namesOnceHolding(workspace, "quadratic-form.md"), [
      "lattices",
      "quadratic-form.md",
    ]);
  });

  it("a document without a shown row asks for the name under its tab", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const form = path.join(lattices, "form.md");
    const folder = activePage.locator(`#file-tree [data-path=${JSON.stringify(lattices)}]`).first();
    await folder.locator(".item-icon").click();
    await openFromRow(activePage, form);
    // The author closes the folder: the row of the document is not shown.
    await folder.locator(".item-icon").click();
    await activePage
      .locator(`#file-tree [data-path=${JSON.stringify(form)}]`)
      .waitFor({ state: "detached" });
    await activePage.locator(".main-editor-wrapper .cm-content:visible").click();

    await pressKey(await windowOfPage(activePage), "ctrl+r");
    const field = activePage.locator(".file-rename input");
    await field.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await field.inputValue(), "form.md", "the field holds the name");
    await field.fill("discriminant-form.md");
    await field.press("Enter");
    assert.deepEqual(await namesOnceHolding(lattices, "discriminant-form.md"), [
      "discriminant-form.md",
    ]);
  });
});

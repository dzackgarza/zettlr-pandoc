/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        "Duplicate file" E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Duplicate file" of a file row writes a copy of the file
 *                  beside it and opens the copy in the window whose row the
 *                  author used (#57). The contract of `file-duplicate`, the
 *                  row that sends it and the command that runs it name the
 *                  window by one field (`ApplicationPayload`); a window that
 *                  the command cannot find opens no copy.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const SOURCE_TEXT = "# Genus\n\nTwo lattices in one genus.\n";

describe("Duplicate file (#57)", function () {
  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let genus = "";

  before(async function () {
    const fixture = await createFixture("zettlr-duplicate-", {
      documentName: "genus.md",
      documentContents: SOURCE_TEXT,
    });
    genus = fixture.documentPath;
    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, []));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  it("writes the copy beside the file and opens it in the window", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const copy = path.join(path.dirname(genus), "Copy of genus.md");

    await activePage
      .locator(`#file-tree [data-path=${JSON.stringify(genus)}]`)
      .first()
      .click({ button: "right" });
    await activePage.locator(".application-menu .menu-item", { hasText: "Duplicate file" }).click();

    const tab = activePage.locator(`[role="tab"][data-path=${JSON.stringify(copy)}]`);
    await tab.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await readFile(copy, "utf8"), SOURCE_TEXT);
    assert.equal(
      await activePage.locator('[role="tab"].active').getAttribute("data-path"),
      copy,
      "the copy is the active document of the pane",
    );
  });
});

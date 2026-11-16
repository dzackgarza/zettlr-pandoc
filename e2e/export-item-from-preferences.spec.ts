/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: an export item that the author adds in the Preferences
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: The author adds an export item in the list "Export items" of
 *              the Preferences: a name and a command, with no base and no
 *              extension. The list takes the record with its two empty
 *              cells, the export launcher offers the item, and a choice of
 *              it runs the command with the document as its one argument
 *              (#47, row 47.6.b).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { PreferencesGroups } from "../source/types/common/preferences";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-export-item-from-preferences-e2e-latest");
const FIELDSET = "Export items";
const ITEM = "Stamp";
const LAUNCHER = "[data-command-launcher]";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The command of the item: it writes its one argument to a file beside it. */
const STAMP_SCRIPT = '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$1.stamp"\n';

/** The Preferences window, when it is open. */
function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

describe("assembled app: an export item that the author adds in the Preferences (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notePath = "";
  let scriptPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-export-item-from-preferences-e2e-", {
      documentName: "note.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    notePath = fixture.documentPath;
    scriptPath = path.join(fixture.root, "stamp.sh");
    await writeFile(scriptPath, STAMP_SCRIPT, "utf8");
    await chmod(scriptPath, 0o755);
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

  it("takes a record with a name and a command, and no base and no extension", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(browser, "The application must be running");
    await editorPage.evaluate(
      async (target) => {
        await window.ipc.invoke("application", { command: "open-preferences", payload: target });
      },
      { group: PreferencesGroups.ImportExport, fieldsetTitle: FIELDSET },
    );
    const deadline = Date.now() + 20_000;
    let preferences = preferencesPage(running);
    while (preferences === undefined) {
      assert.ok(Date.now() < deadline, "the Preferences window opens");
      await delay(100);
      preferences = preferencesPage(running);
    }
    const fieldset = preferences.locator(`[data-form-fieldset-title="${FIELDSET}"]`);
    // The last row of the list has one cell for each column of a new record.
    const newRecord = fieldset.locator("tbody tr").last();
    const cells = newRecord.locator("input");
    await cells.first().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await cells.count(), 4, "name, base, command and extension");

    await cells.nth(0).fill(ITEM);
    await cells.nth(2).fill(scriptPath);
    await newRecord.getByRole("button", { name: "Add" }).click();

    await fieldset
      .locator("tbody tr", { hasText: ITEM })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("item-added.png", await preferences.screenshot());
    assert.deepEqual(
      await editorPage.evaluate(() =>
        window.ipc.sendSync("config-provider", {
          command: "get-config",
          payload: { key: "export.items" },
        }),
      ),
      [{ name: ITEM, base: "", command: scriptPath, extension: "" }],
      "the settings have the item with its two empty cells",
    );
    assert.deepEqual(
      await fieldset
        .locator("tbody tr")
        .last()
        .locator("input")
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
      ["", "", "", ""],
      "the cells of the next record are empty",
    );
    await preferences.close();
  });

  it("offers the item in the export launcher and runs its command with the document", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.export" });
    });
    const row = activePage.locator(
      `${LAUNCHER} [data-launcher-row][data-export-item=${JSON.stringify(ITEM)}]`,
    );
    await row.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("launcher.png", await activePage.screenshot());
    await row.click();
    await activePage.locator(LAUNCHER).waitFor({ state: "detached", timeout: 10_000 });

    const stamp = `${notePath}.stamp`;
    const deadline = Date.now() + 30_000;
    while (!existsSync(stamp)) {
      assert.ok(Date.now() < deadline, "the command of the item writes its file");
      await delay(200);
    }
    // The command writes the file in one step; a read that is early has no text.
    let written = await readFile(stamp, "utf8");
    while (written === "" && Date.now() < deadline) {
      await delay(100);
      written = await readFile(stamp, "utf8");
    }
    assert.equal(written, `${notePath}\n`, "the command got the document as its one argument");
    assert.equal(await activePage.locator(ERROR_TOAST).count(), 0, "no error is shown");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of refused operations in the Assets window
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Assets window edits files that the author owns: Lua
 *                  filters, export profiles, the snippets file and the
 *                  custom CSS. A save, a read, an add or a rename that does
 *                  not happen gives one message that names the file and the
 *                  cause, the text of the editor stays marked as unsaved,
 *                  and no file of the author is replaced. The snippets file
 *                  of the fixture is a file of the fixture
 *                  (`editor.snippetsFile`): the run writes no file of the
 *                  author.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-assets-refused-save-e2e-latest");
const NUMBERING = "-- Numbers each theorem.\nreturn {}\n";
const SECTIONS = "-- Numbers each section.\nreturn {}\n";
const FOOTNOTES = "-- Moves each footnote to the end.\nreturn {}\n";
const HANDOUT = "reader: markdown\nwriter: html\n";
const NOTES = "reader: markdown\nwriter: latex\n";
const CSS = "body { hyphens: auto; }\n";
const SNIPPETS = "{}\n";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The time in which the message of a refused operation arrives. */
const MESSAGE_MS = 10_000;
/** The time in which a second message of one failure arrives. */
const SECOND_MESSAGE_MS = 2_000;

/** The message of each error that a window shows. */
function errorMessages(page: Page): Promise<string[]> {
  return page.locator(`${ERROR_TOAST} span:first-child`).allInnerTexts();
}

/**
 * The errors of a window after an operation: the window had the time to show
 * a message, and the first message had the time to get a second.
 */
async function settledErrorMessages(page: Page): Promise<string[]> {
  const deadline = Date.now() + MESSAGE_MS;
  while (Date.now() < deadline && (await page.locator(ERROR_TOAST).count()) === 0) {
    await delay(100);
  }
  await delay(SECOND_MESSAGE_MS);
  return await errorMessages(page);
}

async function dismissErrors(page: Page): Promise<void> {
  const dismiss = page.locator(`${ERROR_TOAST} button[aria-label="Dismiss"]`);
  while ((await dismiss.count()) > 0) {
    await dismiss.first().click();
  }
}

async function findAssetsPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator("#tab-filter-control").count()) > 0) {
          return page;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No Assets window appeared within ${timeoutMs}ms`);
}

/** The text of a file when it is the expected text, or its text ten seconds later. */
async function textThat(file: string, expected: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await readFile(file, "utf8");
  while (Date.now() < deadline && !expected(text)) {
    await delay(100);
    text = await readFile(file, "utf8");
  }
  return text;
}

/** Waits until the names of a directory are the expected ones. */
async function directoryHolds(directory: string, expected: string[]): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  let names = await readdir(directory);
  while (Date.now() < deadline && !expected.every((name) => names.includes(name))) {
    await delay(100);
    names = await readdir(directory);
  }
  return names;
}

describe("a refused operation in the Assets window", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let assetsPage: Page | undefined;
  let fixtureRoot: string | undefined;
  let filters = "";
  let defaults = "";
  let customCss = "";
  let snippets = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();
  /** The files and directories whose permissions a case changed. */
  const restricted = new Set<string>();

  async function restrict(file: string, mode: number): Promise<void> {
    restricted.add(file);
    await chmod(file, mode);
  }

  async function release(file: string): Promise<void> {
    await chmod(file, 0o644);
    restricted.delete(file);
  }

  function assets(): Page {
    return requireInitialized(assetsPage, "The Assets window must be open");
  }

  async function openTab(id: string): Promise<void> {
    await assets().locator(`#${id}`).click();
    await assets().locator(".asset-container").waitFor({ state: "visible", timeout: 20_000 });
  }

  /** Opens a tab with a list and waits until the tab loaded its first file. */
  async function openListTab(id: string): Promise<void> {
    await openTab(id);
    await assets().waitForFunction(
      () => document.querySelector<HTMLInputElement>(".asset-input-name input")?.value !== "",
      undefined,
      { timeout: 20_000 },
    );
  }

  function row(name: string): Locator {
    return assets()
      .locator(".selectable-list-container .item")
      .filter({ has: assets().getByText(name, { exact: true }) });
  }

  /**
   * Selects the list row of a name and waits until the tab loaded the file.
   * A row that is selected already has its file.
   */
  async function select(name: string, fileName: string): Promise<void> {
    const classes = await row(name).getAttribute("class");
    if (classes !== null && classes.split(" ").includes("selected")) {
      return;
    }
    await row(name).click();
    await assets().waitForFunction(
      (expected) =>
        document.querySelector<HTMLInputElement>(".asset-input-name input")?.value === expected,
      fileName,
      { timeout: 20_000 },
    );
  }

  async function typeAtEnd(text: string): Promise<void> {
    await assets().locator(".asset-container .cm-content").click();
    await assets().keyboard.press("Control+End");
    await assets().keyboard.type(text);
  }

  async function save(): Promise<void> {
    await assets().locator(".save-asset-file button.primary").click();
  }

  function savingStatus(): Promise<string> {
    return assets().locator("span.saving-status").innerText();
  }

  /** Adds a list item under a name through the popover of the list footer. */
  async function add(name: string): Promise<void> {
    await assets().locator(".selectable-list-footer .add").click();
    const field = assets().locator(".popover input[type=text]");
    await field.waitFor({ state: "visible", timeout: 10_000 });
    await field.fill(name);
    await field.press("Enter");
  }

  async function rename(name: string, button: string): Promise<void> {
    await assets().locator(".asset-input-name input").fill(name);
    await assets().getByRole("button", { name: button, exact: true }).click();
  }

  before(async function () {
    const fixture = await createFixture("zettlr-assets-refused-save-e2e-", {
      documentName: "note.md",
      documentContents: "# Lattices\n",
    });
    fixtureRoot = fixture.root;
    filters = path.join(fixture.configDirectory, "lua-filter");
    defaults = path.join(fixture.configDirectory, "defaults");
    customCss = path.join(fixture.configDirectory, "custom.css");
    snippets = path.join(fixture.root, "snippets", "author.code-snippets");
    await mkdir(filters);
    await mkdir(defaults);
    await mkdir(path.dirname(snippets));
    await writeFile(path.join(filters, "footnotes.lua"), FOOTNOTES);
    await writeFile(customCss, CSS);
    await writeFile(snippets, SNIPPETS);
    const configFile = path.join(fixture.configDirectory, "config.json");
    const stored: unknown = JSON.parse(await readFile(configFile, "utf8"));
    assert.ok(stored !== null && typeof stored === "object", "the fixture has a configuration");
    await writeFile(
      configFile,
      `${JSON.stringify({ ...stored, editor: { snippetsFile: snippets } }, null, 2)}\n`,
    );
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    await page.evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.assets_manager",
      });
    });
    assetsPage = await findAssetsPage(app.browser, 30_000);

    await assetsPage.setViewportSize({ width: 1100, height: 760 });
  });

  // Each case starts from the files that no case may change, so that the
  // result of one case does not decide the result of the next.
  beforeEach(async function () {
    await writeFile(path.join(filters, "numbering.lua"), NUMBERING);
    await writeFile(path.join(filters, "sections.lua"), SECTIONS);
    await writeFile(path.join(defaults, "Handout.yaml"), HANDOUT);
    await writeFile(path.join(defaults, "Notes.yaml"), NOTES);
  });

  afterEach(async function () {
    for (const file of [...restricted]) {
      await release(file);
    }
    if (assetsPage !== undefined && !assetsPage.isClosed()) {
      await dismissErrors(assetsPage);
    }
  });

  after(async function () {
    // The application quits when its last window closes, so the Assets
    // window closes before the main window does.
    if (assetsPage !== undefined && !assetsPage.isClosed()) {
      const closed = assetsPage.waitForEvent("close", { timeout: 10_000 });
      await requestWindowClose(assetsPage);
      await closed;
    }
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

  describe("a Lua filter", function () {
    it("shows why a save did not happen and keeps the text unsaved", async function () {
      const file = path.join(filters, "numbering.lua");
      await openListTab("tab-filter-control");
      await select("numbering", "numbering.lua");
      await restrict(file, 0o444);

      await typeAtEnd("-- A change that the file refuses.");
      await save();

      const messages = await settledErrorMessages(assets());
      screenshots.set("filter-save.png", await assets().screenshot());
      assert.deepEqual(messages, ["Could not save numbering.lua: permission denied."]);
      assert.equal(await savingStatus(), "Unsaved changes");
      assert.equal(await readFile(file, "utf8"), NUMBERING, "the file keeps its text");

      // The text is still unsaved, so the author can save it when the file
      // takes it.
      await dismissErrors(assets());
      await release(file);
      await save();
      const saved = await textThat(file, (text) => text !== NUMBERING);
      assert.equal(saved, `${NUMBERING}-- A change that the file refuses.`);
    });

    it("shows why the text of a filter is not there and offers no save of other text", async function () {
      const file = path.join(filters, "sections.lua");
      await openListTab("tab-filter-control");
      await select("numbering", "numbering.lua");
      await restrict(file, 0o000);

      await row("sections").click();

      const messages = await settledErrorMessages(assets());
      screenshots.set("filter-read.png", await assets().screenshot());
      assert.deepEqual(messages, ["Could not read sections.lua: permission denied."]);
      assert.equal(
        await assets().locator(".asset-container .cm-content").innerText(),
        "\n",
        "the editor shows no text of another filter",
      );
      assert.equal(
        await assets().locator(".save-asset-file button.primary").isDisabled(),
        true,
        "no save of a filter whose text the window does not have",
      );
    });

    it("keeps a filter that has the name of a new one", async function () {
      await openListTab("tab-filter-control");
      await select("numbering", "numbering.lua");

      await add("sections");

      const messages = await settledErrorMessages(assets());
      screenshots.set("filter-add.png", await assets().screenshot());
      assert.equal(await readFile(path.join(filters, "sections.lua"), "utf8"), SECTIONS);
      assert.deepEqual(messages, [
        "Could not create sections.lua: a file of this name exists already.",
      ]);
    });

    it("keeps a filter that has the new name of another one", async function () {
      await openListTab("tab-filter-control");
      await select("numbering", "numbering.lua");

      await rename("sections", "Rename filter");

      const messages = await settledErrorMessages(assets());
      screenshots.set("filter-rename.png", await assets().screenshot());
      assert.equal(await readFile(path.join(filters, "sections.lua"), "utf8"), SECTIONS);
      assert.equal(await readFile(path.join(filters, "numbering.lua"), "utf8"), NUMBERING);
      assert.deepEqual(messages, ["Could not rename numbering.lua: sections.lua exists already."]);
    });

    it("gives a filter the name that the author wrote with its extension", async function () {
      await openListTab("tab-filter-control");
      await select("footnotes", "footnotes.lua");

      await rename("endnotes.lua", "Rename filter");

      const names = await directoryHolds(filters, ["endnotes.lua"]);
      screenshots.set("filter-renamed.png", await assets().screenshot());
      assert.equal(names.includes("endnotes.lua"), true, `the filters are ${names.join(", ")}`);
      assert.equal(names.includes("footnotes.lua"), false, "the filter has one name");
      assert.equal(await readFile(path.join(filters, "endnotes.lua"), "utf8"), FOOTNOTES);
      assert.deepEqual(await errorMessages(assets()), []);
    });
  });

  describe("an export profile", function () {
    it("shows why a save did not happen and keeps the text unsaved", async function () {
      const file = path.join(defaults, "Handout.yaml");
      await openListTab("tab-export-control");
      await select("Handout", "Handout.yaml");
      await restrict(file, 0o444);

      await typeAtEnd("# A change that the file refuses.");
      await save();

      const messages = await settledErrorMessages(assets());
      screenshots.set("profile-save.png", await assets().screenshot());
      assert.deepEqual(messages, ["Could not save Handout.yaml: permission denied."]);
      assert.equal(await savingStatus(), "Unsaved changes");
      assert.equal(await readFile(file, "utf8"), HANDOUT, "the file keeps its text");
    });

    it("keeps a profile that has the name of a new one", async function () {
      await openListTab("tab-export-control");
      await select("Handout", "Handout.yaml");

      await add("Notes");

      const messages = await settledErrorMessages(assets());
      screenshots.set("profile-add.png", await assets().screenshot());
      assert.equal(await readFile(path.join(defaults, "Notes.yaml"), "utf8"), NOTES);
      assert.deepEqual(messages, [
        "Could not create Notes.yaml: a file of this name exists already.",
      ]);
    });

    it("keeps a profile that has the new name of another one", async function () {
      await openListTab("tab-export-control");
      await select("Handout", "Handout.yaml");

      await rename("Notes.yaml", "Rename file");

      const messages = await settledErrorMessages(assets());
      screenshots.set("profile-rename.png", await assets().screenshot());
      assert.equal(await readFile(path.join(defaults, "Notes.yaml"), "utf8"), NOTES);
      assert.equal(await readFile(path.join(defaults, "Handout.yaml"), "utf8"), HANDOUT);
      assert.deepEqual(messages, ["Could not rename Handout.yaml: Notes.yaml exists already."]);
    });
  });

  describe("the snippets file", function () {
    it("shows why a save did not happen and keeps the text unsaved", async function () {
      await openTab("tab-snippets-control");
      await assets().waitForFunction(
        (expected) => document.querySelector(".asset-admonition code")?.textContent === expected,
        snippets,
        { timeout: 20_000 },
      );
      await restrict(snippets, 0o444);

      await typeAtEnd(" ");
      await save();

      const messages = await settledErrorMessages(assets());
      screenshots.set("snippets-save.png", await assets().screenshot());
      assert.deepEqual(messages, ["Could not save author.code-snippets: permission denied."]);
      assert.equal(await savingStatus(), "Unsaved changes");
      assert.equal(await readFile(snippets, "utf8"), SNIPPETS, "the file keeps its text");
    });
  });

  describe("the custom CSS", function () {
    it("shows why a save did not happen and keeps the text unsaved", async function () {
      await openTab("tab-custom-css-control");
      await assets()
        .locator(".cm-content", { hasText: "hyphens: auto" })
        .waitFor({ state: "visible", timeout: 20_000 });
      await restrict(customCss, 0o444);

      await typeAtEnd("/* A change that the file refuses. */");
      await save();

      const messages = await settledErrorMessages(assets());
      screenshots.set("css-save.png", await assets().screenshot());
      assert.deepEqual(messages, ["Could not save custom.css: permission denied."]);
      assert.equal(await savingStatus(), "Unsaved changes");
      assert.equal(await readFile(customCss, "utf8"), CSS, "the file keeps its text");
    });
  });
});

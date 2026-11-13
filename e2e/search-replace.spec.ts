/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Search and replace e2e
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Search view on VS Code's search view (M11, D11): a
 *                  query that searches as it is typed, its three matching
 *                  options, the globs that scope it, result rows that read
 *                  as one line each and show what a replacement would do,
 *                  and replacing all of them, one file's, or one match —
 *                  with the row a dismissal removed left alone.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createWorkspaceFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  REPO_ROOT,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-search-replace-e2e-latest");

const VIEW = '#navigation-sidebar[data-view="search"] #search-view';
const QUERY = `${VIEW} input[name="search-input"]`;
const REPLACEMENT = `${VIEW} input[name="replace-input"]`;
const MESSAGE = `${VIEW} .search-message`;
const NOT_SEARCHED = `${VIEW} [data-search-not-searched]`;
const FILE_ROW = `${VIEW} .file-match`;
const ACTION = (name: string): string => `[data-search-action="${name}"]`;
const TOGGLE = (name: string): string => `${VIEW} [data-search-toggle="${name}"]`;

/** A row's own actions appear when the pointer is on it, as they do in the reference. */
async function clickRowAction(row: Locator, action: string): Promise<void> {
  await row.hover();
  await row.locator(ACTION(action)).click();
}

interface ConfirmationPainting {
  centre: [number, number];
  viewportCentre: [number, number];
  replace: string;
  cancel: string;
  accent: string;
  surface: string;
  text: string;
  chromeText: string;
}

/**
 * Where the Replace All confirmation is, the background of its two actions,
 * and what the colour tokens of the window resolve to on an element of
 * `body`, which is where the confirmation is.
 */
async function confirmationPainting(page: Page): Promise<ConfirmationPainting> {
  return await page.evaluate(() => {
    const replace = document.querySelector('[data-search-confirm="replace-all"]');
    const dialog = replace?.closest('[role="alertdialog"]');
    const cancel = dialog?.querySelector("button:not([data-search-confirm])");
    if (replace == null || dialog == null || cancel == null) {
      throw new Error("The Replace All confirmation is not open");
    }
    const box = dialog.getBoundingClientRect();
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.backgroundColor = "var(--chrome-row-accent)";
    const accent = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = "var(--chrome-surface)";
    const surface = getComputedStyle(probe).backgroundColor;
    probe.style.color = "var(--chrome-text)";
    const chromeText = getComputedStyle(probe).color;
    probe.remove();
    return {
      text: getComputedStyle(dialog).color,
      chromeText,
      centre: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
      viewportCentre: [Math.round(innerWidth / 2), Math.round(innerHeight / 2)],
      replace: getComputedStyle(replace).backgroundColor,
      cancel: getComputedStyle(cancel).backgroundColor,
      accent,
      surface,
    };
  });
}

const TERM = "subgroupoid";
const REPLACES_WITH = "subcategory";
// A word of both files that no case replaces.
const IN_BOTH_FILES = "maximal";

async function waitUntil(
  probe: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function editorText(page: Page): Promise<string> {
  return page.locator(".cm-content").innerText();
}

/** Types a query and waits for the view to say what it found. */
async function search(page: Page, text: string, expected: RegExp): Promise<void> {
  await page.locator(QUERY).fill(text);
  await waitUntil(
    async () => expected.test(await page.locator(MESSAGE).innerText()),
    `the view to report ${String(expected)}`,
  );
}

function fileRow(page: Page, name: string): Locator {
  return page.locator(`${VIEW} .file-match[data-path$="/${name}"]`);
}

function matchRows(page: Page, name: string): Locator {
  return page.locator(`${VIEW} .line-match[data-path$="/${name}"]`);
}

/** The results list recycles its rows, so DOM order is not line order. */
function matchRowAt(page: Page, name: string, line: number): Locator {
  return page.locator(`${VIEW} .line-match[data-path$="/${name}"][data-line="${line}"]`);
}

describe("the Search view", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory: string | undefined;
  let page: Page | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  const closedFile = (): string =>
    path.join(
      requireInitialized(fixtureRoot, "fixture root"),
      "workspace",
      "computation",
      "sage.md",
    );
  const openFile = (): string =>
    path.join(
      requireInitialized(fixtureRoot, "fixture root"),
      "workspace",
      "foundations",
      "categories.md",
    );

  before(async function () {
    // categories.md is the open document and carries the term once;
    // sage.md is closed and carries it twice.
    const fixture = await createWorkspaceFixture("zettlr-search-replace-e2e-", {
      workspaceSource: path.join(REPO_ROOT, "test", "fixtures", "quarto-book"),
      activeDocument: path.join("foundations", "categories.md"),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: false },
        ui: { sidebarView: "search" },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    const app = await attach(
      requireInitialized(configDirectory, "config directory"),
      rendererEvents,
      this.timeout(),
    );
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    const editorPage = await findEditorPage(browser, this.timeout());
    await hideDevServerOverlay(editorPage);
    await editorPage.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    await editorPage.locator(VIEW).waitFor({ timeout: 60_000 });
    await editorPage.setViewportSize({ width: 1500, height: 950 });
    page = editorPage;
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

  it("searches as the query is typed and reads out what it found, one line per match", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await search(activePage, TERM, /3 results in 2 files/);
    assert.deepEqual(
      (await activePage.locator(`${FILE_ROW} .file-match-name`).allTextContents()).sort(),
      ["categories.md", "sage.md"],
      "one row per file, named by its file",
    );
    assert.equal(
      await fileRow(activePage, "sage.md").locator(".file-match-count").innerText(),
      "2",
      "the badge counts that file's matches",
    );

    const firstSageMatch = matchRowAt(activePage, "sage.md", 3);
    assert.equal(await firstSageMatch.locator(".match-before").innerText(), "Compute the maximal ");
    assert.equal(await firstSageMatch.locator(".match-inside").innerText(), TERM);
    assert.equal(await firstSageMatch.locator(".match-after").innerText(), " with Sage.");
    screenshots.set("results.png", await activePage.screenshot());
  });

  it("shows what the replacement would do before anything is replaced", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(ACTION("toggle-replace")).click();
    await activePage.locator(REPLACEMENT).fill(REPLACES_WITH);
    const firstSageMatch = matchRows(activePage, "sage.md").first();
    await waitUntil(
      async () => (await firstSageMatch.locator(".match-replace").count()) === 1,
      "the row to show the replacement",
    );
    assert.equal(await firstSageMatch.locator(".match-replace").innerText(), REPLACES_WITH);
    assert.match(
      await editorText(activePage),
      /subgroupoid/,
      "the document is untouched while it is only a preview",
    );
    screenshots.set("replace-preview.png", await activePage.screenshot());
  });

  it("narrows the search with the matching options and the file globs", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await search(activePage, "core", /3 results in 2 files/);
    await activePage.locator(TOGGLE("match-case")).click();
    await search(activePage, "Core", /1 result in 1 file/);
    await activePage.locator(TOGGLE("match-case")).click();

    await search(activePage, "group", /3 results in 2 files/);
    await activePage.locator(TOGGLE("whole-word")).click();
    await waitUntil(
      async () => /No results found/.test(await activePage.locator(MESSAGE).innerText()),
      "no whole-word match for a word inside another",
    );
    await activePage.locator(TOGGLE("whole-word")).click();

    await activePage.locator(TOGGLE("regex")).click();
    await search(activePage, "sub\\w+oid", /3 results in 2 files/);
    await activePage.locator(TOGGLE("regex")).click();

    await activePage.locator(ACTION("toggle-details")).click();
    await activePage.locator(`${VIEW} input[name="files-to-exclude"]`).fill("computation/**");
    await search(activePage, TERM, /1 result in 1 file/);
    await activePage.locator(`${VIEW} input[name="files-to-exclude"]`).fill("");
    await search(activePage, TERM, /3 results in 2 files/);
    screenshots.set("search-details.png", await activePage.screenshot());
  });

  it("replaces every match once the owner confirms: the open document in its editor and on disk, the closed file on disk", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(REPLACEMENT).fill(REPLACES_WITH);
    await activePage.locator(`${VIEW} ${ACTION("replace-all")}`).click();
    const confirm = activePage.locator(`[data-search-confirm="replace-all"]`);
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await activePage.locator("[data-search-confirm-message]").innerText(),
      /3 occurrences across 2 files/,
      "the confirmation counts what it is about to change",
    );
    screenshots.set("replace-all-confirmation.png", await activePage.screenshot());
    const painted = await confirmationPainting(activePage);
    assert.deepEqual(
      painted.centre,
      painted.viewportCentre,
      "the confirmation is in the middle of the window",
    );
    assert.equal(
      painted.replace,
      painted.accent,
      "the action that replaces has the accent colour of the window",
    );
    assert.equal(
      painted.cancel,
      painted.surface,
      "the action that cancels has the surface colour of the window",
    );
    assert.equal(
      painted.text,
      painted.chromeText,
      "the confirmation has the text colour of the window chrome",
    );
    await confirm.click();

    await waitUntil(
      async () =>
        /subcategory/.test(await editorText(activePage)) &&
        !/subgroupoid/.test(await editorText(activePage)),
      "the open document to change in its editor",
    );
    await waitUntil(
      async () => (await readFile(closedFile(), "utf-8")).includes(REPLACES_WITH),
      "the closed file to change on disk",
    );
    await waitUntil(
      async () => (await readFile(openFile(), "utf-8")).includes(REPLACES_WITH),
      "the open document to be saved",
    );
    await waitUntil(
      async () => /No results found/.test(await activePage.locator(MESSAGE).innerText()),
      "the results to refresh with nothing left",
    );
    screenshots.set("after-replace-all.png", await activePage.screenshot());
  });

  it("undoes the last replace from the view", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(`${VIEW} ${ACTION("undo-replace")}`).click();
    await waitUntil(
      async () =>
        /subgroupoid/.test(await editorText(activePage)) &&
        !/subcategory/.test(await editorText(activePage)),
      "the open document to come back",
    );
    await waitUntil(
      async () => (await readFile(closedFile(), "utf-8")).includes(TERM),
      "the closed file to come back",
    );
    await search(activePage, TERM, /3 results in 2 files/);
  });

  it("replaces one file's matches from its row, and one match from its own", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(REPLACEMENT).fill(REPLACES_WITH);
    await clickRowAction(fileRow(activePage, "sage.md"), "replace-file");
    await waitUntil(async () => {
      const text = await readFile(closedFile(), "utf-8");
      return [...text.matchAll(/subcategory/g)].length === 2 && !text.includes(TERM);
    }, "both matches of the closed file to change");
    assert.match(await editorText(activePage), /subgroupoid/, "the other file is untouched");
    await search(activePage, TERM, /1 result in 1 file/);

    await activePage.locator(`${VIEW} ${ACTION("undo-replace")}`).click();
    await search(activePage, TERM, /3 results in 2 files/);

    await activePage.locator(REPLACEMENT).fill(REPLACES_WITH);
    await clickRowAction(matchRows(activePage, "sage.md").first(), "replace-match");
    await waitUntil(async () => {
      const text = await readFile(closedFile(), "utf-8");
      return (
        [...text.matchAll(/subcategory/g)].length === 1 &&
        [...text.matchAll(/subgroupoid/g)].length === 1
      );
    }, "exactly one match of the closed file to change");
    await search(activePage, TERM, /2 results in 2 files/);
    screenshots.set("after-replace-match.png", await activePage.screenshot());
  });

  it("leaves a dismissed row out of the replace", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(`${VIEW} ${ACTION("undo-replace")}`).click();
    await search(activePage, TERM, /3 results in 2 files/);

    await clickRowAction(fileRow(activePage, "sage.md"), "dismiss-file");
    await waitUntil(
      async () => (await fileRow(activePage, "sage.md").count()) === 0,
      "the dismissed file to leave the results",
    );
    assert.equal(
      await activePage.locator(`${FILE_ROW}:visible`).count(),
      1,
      "the other file stays",
    );

    await activePage.locator(REPLACEMENT).fill(REPLACES_WITH);
    await activePage.locator(`${VIEW} ${ACTION("replace-all")}`).click();
    await activePage.locator(`[data-search-confirm="replace-all"]`).click();
    await waitUntil(
      async () => /subcategory/.test(await editorText(activePage)),
      "the file that stayed to be replaced",
    );
    assert.equal(
      (await readFile(closedFile(), "utf-8")).includes(TERM),
      true,
      "the dismissed file is untouched",
    );
    screenshots.set("after-dismiss.png", await activePage.screenshot());
  });

  it("says why a regular expression the engine refused found nothing, instead of reading out an empty search", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator(QUERY).fill("sub(");
    await activePage.locator(TOGGLE("regex")).click();
    assert.equal(
      await activePage.locator(TOGGLE("regex")).getAttribute("aria-pressed"),
      "true",
      "the expression has to be read as one for this to prove anything",
    );
    await waitUntil(
      async () =>
        await activePage
          .locator(MESSAGE)
          .evaluate((el) => el.classList.contains("search-message-error")),
      `the view to read the refused expression as an error (it reads "${await activePage.locator(MESSAGE).innerText()}")`,
    );
    const reported = await activePage.locator(MESSAGE).innerText();
    assert.notEqual(
      reported.trim(),
      "No results found.",
      "an expression the engine refused is not a search that found nothing",
    );
    screenshots.set("search-invalid-regex.png", await activePage.screenshot());

    await activePage.locator(TOGGLE("regex")).click();
    await search(activePage, TERM, /result/);
  });

  it("searches the other files and names the file that it cannot read", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await chmod(closedFile(), 0o000);
    await assert.rejects(
      readFile(closedFile(), "utf-8"),
      "the fixture file must really be unreadable for this to prove anything",
    );

    // sage.md is before categories.md in the order of the workspace: the
    // search reads the file that it cannot read first.
    // The view shows no message while a search runs, and the search of the
    // case before can end after this one starts. The wait is therefore for
    // a message of this search: its count, or an error.
    await activePage.locator(QUERY).fill("");
    await activePage.locator(QUERY).fill(IN_BOTH_FILES);
    const refused = activePage.locator(`${MESSAGE}.search-message-error`);
    const counted = activePage.locator(MESSAGE, { hasText: /^1 result in 1 file/ });
    await waitUntil(
      async () => (await refused.count()) + (await counted.count()) > 0,
      "the search to end with a message",
    );
    screenshots.set("search-unreadable-file.png", await activePage.screenshot());
    assert.deepEqual(
      // The list keeps the rows that it recycles in the document, hidden.
      await activePage.locator(`${FILE_ROW}:visible .file-match-name`).allTextContents(),
      ["categories.md"],
      "the file that can be read is searched",
    );
    assert.match(
      await activePage.locator(MESSAGE).innerText(),
      /1 result in 1 file/,
      "the count is that of the files that were searched",
    );
    const notSearched = activePage.locator(NOT_SEARCHED);
    assert.equal(await notSearched.count(), 1, "the view says that a file was not searched");
    assert.match(await notSearched.innerText(), /sage\.md/, "the view names the file");

    // The file can be read again: the next search reads it, and the view
    // names no file.
    await chmod(closedFile(), 0o644);
    await activePage.locator(QUERY).fill("");
    await search(activePage, IN_BOTH_FILES, /2 results in 2 files/);
    assert.equal(await notSearched.count(), 0, "each file was searched");
  });

  it("searches the other files and names the folder that it cannot list (#210)", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const folder = path.dirname(closedFile());
    await chmod(folder, 0o000);
    try {
      await assert.rejects(
        readFile(closedFile(), "utf-8"),
        "the fixture folder must really refuse its content for this to prove anything",
      );
      await activePage.locator(QUERY).fill("");
      await activePage.locator(QUERY).fill(IN_BOTH_FILES);
      await waitUntil(
        async () =>
          (await activePage.locator(MESSAGE, { hasText: /^1 result in 1 file/ }).count()) > 0,
        "the search to end with its count",
      );
      screenshots.set("search-unlistable-folder.png", await activePage.screenshot());
      assert.deepEqual(
        await activePage.locator(`${FILE_ROW}:visible .file-match-name`).allTextContents(),
        ["categories.md"],
        "the file beside the folder is searched",
      );
      const notSearched = activePage.locator(NOT_SEARCHED);
      assert.equal(await notSearched.count(), 1, "the view says that a folder was not searched");
      assert.match(
        await notSearched.innerText(),
        /^1 folder was not searched:\s+computation/,
        "the view names the folder as a folder",
      );
    } finally {
      await chmod(folder, 0o755);
    }
    await activePage.locator(QUERY).fill("");
    await search(activePage, IN_BOTH_FILES, /2 results in 2 files/);
    assert.equal(await activePage.locator(NOT_SEARCHED).count(), 0, "each file was searched");
  });
});

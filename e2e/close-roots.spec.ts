/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Close of root files and of all workspaces E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author closes a root file from the context menu of
 *                  its row, and closes all workspaces from the menu of the
 *                  Workspaces header; one workspace is inside the other.
 *                  Each close asks one time about the unsaved text of the
 *                  documents that it closes, and the answer No closes each
 *                  such document and writes nothing (#210).
 *
 *                  The spec answers native message boxes, so it runs on the
 *                  display of the run only.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
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
import { captureWindow, nativeDialog, nativeDialogs, pressKey } from "./support/native-dialog";
import { leafIds, openInLeaf } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-close-roots-e2e-latest");
const PROMPT_TITLE = "Unsaved changes";
const CONFIRM_TITLE = "Close all";
const GENUS = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const LEMMA = "# Lemma\n\nA unimodular lattice is its own dual.\n";
const ROOT_FILE = "# Discriminant\n\nThe discriminant group of an even lattice has a form.\n";
const SENTENCE = " A sentence that the author did not save.";

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

/** The paths of the tabs of every pane of the window. */
async function openTabs(page: Page): Promise<string[]> {
  return await page
    .locator('[role="tab"][data-path]')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-path") ?? ""));
}

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

describe("assembled app: the close of root files and of all workspaces", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let inner = "";
  let genusPath = "";
  let lemmaPath = "";
  let rootFilePath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-close-roots-e2e-", {
      documentName: "genus.md",
      documentContents: GENUS,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        fileManagerMode: "combined",
        window: { fileManagerVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    genusPath = fixture.documentPath;
    workspace = path.dirname(genusPath);
    inner = path.join(workspace, "lemmas");
    lemmaPath = path.join(inner, "lemma.md");
    rootFilePath = path.join(fixture.root, "notes", "discriminant.md");
    await mkdir(inner);
    await writeFile(lemmaPath, LEMMA, "utf8");
    await mkdir(path.dirname(rootFilePath));
    await writeFile(rootFilePath, ROOT_FILE, "utf8");
    // The fixture opens one workspace; this spec opens an inner workspace and
    // a root file beside it.
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config: { app: { openFiles: string[]; openWorkspaces: string[] } } = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    config.app = { openFiles: [rootFilePath], openWorkspaces: [workspace, inner] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: 1400, height: 900 });
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

  function row(activePage: Page, rowPath: string) {
    return activePage.locator(`.tree-item.root[data-path=${JSON.stringify(rowPath)}]`);
  }

  /** Opens `filePath` in the one pane and types a sentence that the author does not save. */
  async function typeUnsaved(activePage: Page, filePath: string): Promise<void> {
    const [leaf] = await leafIds(activePage);
    await openInLeaf(activePage, leaf, filePath);
    await activePage
      .locator(`[role="tab"][data-path=${JSON.stringify(filePath)}].active`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await activePage.locator(".cm-content:visible").click();
    await activePage.keyboard.press("ControlOrMeta+End");
    await activePage.keyboard.type(SENTENCE);
    await activePage
      .locator(`[role="tab"][data-path=${JSON.stringify(filePath)}].modified`)
      .waitFor({ state: "visible", timeout: 30_000 });
  }

  /** Answers No in the prompt about unsaved text. */
  async function answerNo(prompt: string): Promise<void> {
    await pressKey(prompt, "Tab");
    await pressKey(prompt, "space");
  }

  it("asks about the unsaved text of a root file that closes", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await typeUnsaved(activePage, rootFilePath);

    await row(activePage, rootFilePath).click({ button: "right" });
    const item = activePage
      .locator('.application-menu .menu-item[data-id="menu.close_file"]')
      .last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();
    const prompt = await nativeDialog(PROMPT_TITLE, 30_000);
    screenshots.set("root-file-prompt.png", await captureWindow(prompt));
    await answerNo(prompt);

    await waitUntil(
      async () => (await row(activePage, rootFilePath).count()) === 0,
      "the root file to close",
    );
    assert.equal(await readFile(rootFilePath, "utf8"), ROOT_FILE, "the answer No writes nothing");
    assert.deepEqual(await modifiedDocuments(activePage), [], "no document holds the text");
    await waitUntil(
      async () => !(await openTabs(activePage)).includes(rootFilePath),
      "the tab of the root file to close",
    );
  });

  it("asks one time about the documents of all workspaces, also of a workspace inside another", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await typeUnsaved(activePage, genusPath);
    await typeUnsaved(activePage, lemmaPath);

    await activePage.locator("#directories-dirs-header").click({ button: "right" });
    const item = activePage
      .locator(".application-menu .menu-item", { hasText: "Close all workspaces" })
      .last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click();
    const confirm = await nativeDialog(CONFIRM_TITLE, 30_000);
    // The buttons are Cancel and Ok; Cancel has the focus.
    await pressKey(confirm, "Tab");
    await pressKey(confirm, "space");

    const prompt = await nativeDialog(PROMPT_TITLE, 30_000);
    screenshots.set("all-workspaces-prompt.png", await captureWindow(prompt));
    await answerNo(prompt);

    await waitUntil(
      async () =>
        (await row(activePage, workspace).count()) === 0 &&
        (await row(activePage, inner).count()) === 0,
      "both workspaces to close",
    );
    screenshots.set("all-closed.png", await activePage.screenshot());
    assert.equal(await readFile(genusPath, "utf8"), GENUS, "the answer No writes nothing");
    assert.equal(await readFile(lemmaPath, "utf8"), LEMMA);
    assert.deepEqual(await modifiedDocuments(activePage), [], "no document holds the text");
    await waitUntil(
      async () => (await openTabs(activePage)).length === 0,
      "each document of the workspaces to close",
    );
    assert.deepEqual(await nativeDialogs(PROMPT_TITLE, 2_000), [], "one close asks one time");
  });
});

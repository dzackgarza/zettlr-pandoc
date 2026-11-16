/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: fast opens and fast tab switches in the assembled app
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: A document loads into its editor after its tab exists, so the
 *              load of one document can end after the author went on to
 *              another tab. The spec opens six documents at once, one of
 *              them long, and switches tabs faster than a load takes. After
 *              each burst the visible editor holds the text of the file of
 *              the active tab, and it still holds it after each load ended.
 *              At the end each tab shows its own file (#47; the defect class
 *              of #44, an editor with the wrong text).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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
import { leafIds } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-fast-tab-switch-e2e-latest");
const FIRST = "# First\n\nThe first document is open at the start.\n";
const LONG_NAME = "long.md";
const SHORT_NAMES = ["genus.md", "rank.md", "discriminant.md", "signature.md"];
/** The time after which each load of a burst has ended. */
const SETTLE_MS = 1_500;

function longDocument(): string {
  const lines = ["# Long document", ""];
  for (let line = 1; line <= 6000; line += 1) {
    lines.push(`Line ${line} of the long document about even unimodular lattices.`);
  }
  return `${lines.join("\n")}\n`;
}

interface VisibleEditor {
  /** The editors that the window shows; one pane shows one. */
  count: number;
  text: string | null;
}

/** The element of an editor, with the CodeMirror view that it carries. */
interface EditorContent extends HTMLElement {
  cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } };
}

/** The text of the editor that the window shows. */
async function visibleEditor(page: Page): Promise<VisibleEditor> {
  return await page.evaluate(() => {
    const shown = Array.from(document.querySelectorAll<EditorContent>(".cm-content")).filter(
      (content) => content.offsetParent !== null,
    );
    if (shown.length !== 1) {
      return { count: shown.length, text: null };
    }
    const view = shown[0].cmTile?.root?.view;
    if (view === undefined) {
      return { count: 1, text: null };
    }
    return { count: 1, text: view.state.doc.toString() };
  });
}

/** The path of the active tab of the one pane. */
async function activeTab(page: Page): Promise<string> {
  const paths = await page
    .locator('.editor-pane [role="tab"].active')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-path")));
  assert.equal(paths.length, 1, "the pane has one active tab");
  const [active] = paths;
  assert.ok(active !== null, "the active tab names its document");
  return active;
}

describe("assembled app: fast opens and fast tab switches (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let documents: string[] = [];
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /**
   * The visible editor holds the file of the active tab, and holds it still
   * after each load of the burst ended.
   */
  async function assertActiveTabShowsItsFile(activePage: Page, burst: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    let active = await activeTab(activePage);
    let shown = await visibleEditor(activePage);
    while (shown.text !== (await readFile(active, "utf8")) && Date.now() < deadline) {
      await delay(100);
      active = await activeTab(activePage);
      shown = await visibleEditor(activePage);
    }
    assert.equal(shown.count, 1, `${burst}: the pane shows one editor`);
    assert.equal(
      shown.text,
      await readFile(active, "utf8"),
      `${burst}: the editor shows the file of the active tab ${path.basename(active)}`,
    );

    await delay(SETTLE_MS);
    assert.equal(await activeTab(activePage), active, `${burst}: the active tab stays`);
    assert.equal(
      (await visibleEditor(activePage)).text,
      await readFile(active, "utf8"),
      `${burst}: no late load replaced the text of ${path.basename(active)}`,
    );
    return active;
  }

  function tab(activePage: Page, documentPath: string) {
    return activePage.locator(
      `.editor-pane [role="tab"][data-path=${JSON.stringify(documentPath)}]`,
    );
  }

  before(async function () {
    const fixture = await createFixture("zettlr-fast-tab-switch-e2e-", {
      documentName: "first.md",
      documentContents: FIRST,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    await writeFile(path.join(workspace, LONG_NAME), longDocument(), "utf8");
    for (const name of SHORT_NAMES) {
      await writeFile(
        path.join(workspace, name),
        `# ${name}\n\nThe document ${name} has this one sentence.\n`,
        "utf8",
      );
    }
    documents = [
      fixture.documentPath,
      path.join(workspace, LONG_NAME),
      ...SHORT_NAMES.map((name) => path.join(workspace, name)),
    ];

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
    assert.deepEqual(rendererEvents, [], "the window reports no error");
  });

  it("shows the file of the active tab after five documents open at once", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const [leaf] = await leafIds(activePage);

    // The opens are sent in one task: the long document first, so its load
    // ends after the opens of the short ones.
    await activePage.evaluate(
      async ([leafId, paths]) => {
        const windowId = new URLSearchParams(location.search).get("window_id");
        if (windowId === null) {
          throw new Error("The main window carries no window_id");
        }
        await Promise.all(
          paths.map((pathInPage) =>
            window.ipc.invoke("documents-provider", {
              command: "open-file",
              payload: { windowId, leafId, path: pathInPage, newTab: true },
            }),
          ),
        );
      },
      [leaf, documents.slice(1)] as const,
    );
    await activePage
      .locator('.editor-pane [role="tab"][data-path]')
      .nth(documents.length - 1)
      .waitFor({ state: "visible", timeout: 20_000 });

    await assertActiveTabShowsItsFile(activePage, "after the opens");
    screenshots.set("after-opens.png", await activePage.screenshot());
  });

  it("shows the file of the active tab after clicks on the tabs with no pause", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const [first, long, ...short] = documents;

    // Each click on the long document is followed at once by a click on
    // another tab, so the author leaves the long document while it loads.
    const order = [long, short[0], long, short[1], first, long, short[2], short[3], long, short[0]];
    for (const documentPath of order) {
      await tab(activePage, documentPath).click();
    }
    const active = await assertActiveTabShowsItsFile(activePage, "after the clicks");
    assert.equal(active, short[0], "the tab of the last click is the active tab");

    for (const documentPath of [short[1], long]) {
      await tab(activePage, documentPath).click();
    }
    assert.equal(
      await assertActiveTabShowsItsFile(activePage, "after a click on the long document"),
      long,
    );
    screenshots.set("after-clicks.png", await activePage.screenshot());
  });

  it("shows its own file in each tab", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    for (const documentPath of documents) {
      await tab(activePage, documentPath).click();
      assert.equal(
        await assertActiveTabShowsItsFile(activePage, `tab ${path.basename(documentPath)}`),
        documentPath,
      );
    }
    for (const documentPath of documents) {
      assert.equal(
        await tab(activePage, documentPath).evaluate((element) =>
          element.classList.contains("modified"),
        ),
        false,
        `${path.basename(documentPath)} has no unsaved change`,
      );
    }
  });
});

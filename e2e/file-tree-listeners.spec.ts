/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File tree event subscription E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace with more rows than the listener limit of the
 *                  renderer IPC. The file tree shows each row and follows a
 *                  file that appears on disk, and the window takes the
 *                  filesystem events without one IPC listener for each row:
 *                  the renderer logs no listener leak warning.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-file-tree-listeners-e2e-latest");
const NOTE_COUNT = 150;
const LEAK_WARNING = /MaxListenersExceededWarning/;

describe("assembled app: a file tree with many rows", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-file-tree-listeners-e2e-", {
      documentName: "index.md",
      documentContents: "# Notes\n",
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: false },
      },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    for (let index = 0; index < NOTE_COUNT; index++) {
      const name = `note-${String(index).padStart(3, "0")}.md`;
      await writeFile(path.join(workspace, name), `# Note ${index}\n`, "utf8");
    }

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: 1200, height: 900 });
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

  it("shows a file that appears on disk and logs no listener leak", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const row = (name: string): string =>
      `.tree-item[data-path=${JSON.stringify(path.join(workspace, name))}]`;
    await shown.locator(row("note-149.md")).waitFor({ state: "attached", timeout: 30_000 });

    await writeFile(path.join(workspace, "appeared.md"), "# Appeared\n", "utf8");
    await shown.locator(row("appeared.md")).waitFor({ state: "attached", timeout: 20_000 });
    screenshots.set("file-tree.png", await shown.screenshot());

    const leaks = getOutput()
      .split("\n")
      .filter((line) => LEAK_WARNING.test(line));
    assert.deepEqual(leaks, [], "the renderer adds no IPC listener for each row");
  });
});

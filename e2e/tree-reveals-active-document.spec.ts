/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of the active document in the file tree
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The application starts with a document in a tab. The
 *                  file tree shows the row of that document: each folder
 *                  from the workspace to the document is open, also when the
 *                  window has the active document before it has the files of
 *                  a large workspace.
 *
 * END HEADER
 */

import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-tree-reveals-active-document-e2e-latest");
/** Enough workspaces that the window has the active document before the last one. */
const OTHER_WORKSPACES = 400;

describe("the file tree at the start of the application", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let genus = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-tree-reveals-active-document-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
      config: {
        fileManagerMode: "combined",
        window: { fileManagerVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    genus = fixture.documentPath;
    // The window reads the files of each workspace in turn, so the active
    // document of the tab arrives before the last workspace does.
    const others = Array.from({ length: OTHER_WORKSPACES }, (_, index) =>
      path.join(fixture.root, "others", `workspace-${String(index).padStart(3, "0")}`),
    );
    await Promise.all(
      others.map(async (workspace) => {
        await mkdir(workspace, { recursive: true });
        await writeFile(path.join(workspace, "note.md"), "# Note\n", "utf8");
      }),
    );
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config: { app: { openWorkspaces: string[] } } = JSON.parse(
      await readFile(configPath, "utf8"),
    );
    config.app.openWorkspaces = [path.dirname(genus), ...others];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
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

  it("shows the row of the document of the open tab", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const workspace = activePage.locator(
      `.tree-item.directory[data-path=${JSON.stringify(path.dirname(genus))}]`,
    );
    await workspace.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("tree-at-start.png", await activePage.screenshot());
    await activePage
      .locator(`.tree-item.file[data-path=${JSON.stringify(genus)}]`)
      .waitFor({ state: "visible", timeout: 10_000 });
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: a Project title that the author types in the Project window
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: The Project properties window saves each change of a field.
 *              The author types a title at the speed of a keyboard: each key
 *              is a change, and a key can arrive while the save of the key
 *              before it is on its way. The settings file of the Project
 *              ends with the whole title. The window draws its fields when
 *              it has the settings of the Project, so the first title that
 *              the field shows is the title of the Project.
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
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { findProjectPropertiesPage } from "./support/project-properties";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-project-properties-typed-title-e2e-latest");
const FIRST_TITLE = "Lattice notes";
const TYPED_TITLE = "Even unimodular lattices of rank 24 and their theta series";
const PROJECT_SETTINGS = {
  sorting: "name-up",
  project: {
    title: FIRST_TITLE,
    profiles: [],
    files: ["note.md"],
    cslStyle: "",
    templates: { tex: "", html: "" },
  },
  icon: null,
  color: null,
};
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

describe("assembled app: a Project title that the author types in the Project window", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let propertiesPage: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let settingsFile = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** The title of the Project in its settings file. */
  async function savedTitle(): Promise<unknown> {
    return JSON.parse(await readFile(settingsFile, "utf8")).project.title;
  }

  before(async function () {
    const fixture = await createFixture("zettlr-project-properties-typed-title-e2e-", {
      documentName: "note.md",
      documentContents: "# Lattices\n\nAn even lattice.\n",
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    settingsFile = path.join(workspace, ".ztr-directory");
    await writeFile(settingsFile, JSON.stringify(PROJECT_SETTINGS), "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    // The application quits when its last window closes, so the Project
    // properties window closes before the main window does.
    if (propertiesPage !== undefined && !propertiesPage.isClosed()) {
      const closed = propertiesPage.waitForEvent("close", { timeout: 10_000 });
      await requestWindowClose(propertiesPage);
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

  it("saves the whole title that the author typed", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const runningBrowser = requireInitialized(browser, "The application must be running");
    await editorPage.evaluate(
      async (payload) =>
        await window.ipc.invoke("application", { command: "open-project-preferences", payload }),
      workspace,
    );
    propertiesPage = await findProjectPropertiesPage(runningBrowser, 30_000);
    const titleInput = propertiesPage.getByLabel("Project Title");
    await titleInput.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await titleInput.inputValue(),
      FIRST_TITLE,
      "the first title that the field shows is the title of the Project",
    );

    await titleInput.click();
    await propertiesPage.keyboard.press("Control+a");
    // No pause between the keys: a key arrives while a save is on its way.
    await propertiesPage.keyboard.type(TYPED_TITLE);
    assert.equal(await titleInput.inputValue(), TYPED_TITLE, "the field has the typed title");

    const deadline = Date.now() + 10_000;
    while ((await savedTitle()) !== TYPED_TITLE && Date.now() < deadline) {
      await delay(100);
    }
    screenshots.set("typed-title.png", await propertiesPage.screenshot());
    assert.equal(await savedTitle(), TYPED_TITLE, "the settings file has the whole title");
    assert.equal(await propertiesPage.locator(ERROR_TOAST).count(), 0, "no error is shown");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a refused change of Project settings
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The workspace is a Project whose settings file takes no
 *                  write. Two surfaces change the settings of a Project: the
 *                  completion of a reference to a file that the Project
 *                  leaves out, in the main window, and the Project
 *                  properties window. Each refused change gives one message,
 *                  in the window that the author works in.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-project-settings-refusal-e2e-latest");
const NOTE = "# Lattices\n\nThe genus of a lattice: see @def\n";
const GENUS = [
  "# Genus",
  "",
  '::: {.definition #def:genus-of-a-lattice title="Genus"}',
  "Two lattices are in one genus when they are isometric over each completion.",
  ":::",
  "",
].join("\n");
const PROJECT_SETTINGS = {
  sorting: "name-up",
  project: {
    title: "Initial project",
    profiles: [],
    files: ["note.md"],
    cslStyle: "",
    templates: { tex: "", html: "" },
  },
  icon: null,
  color: null,
};
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const NOT_SAVED = "Could not save the Project settings of workspace: permission denied.";
const NO_PROJECT = "Could not update project settings because this folder is no longer a Project.";
/** The time in which a second message of one failure arrives. */
const SECOND_MESSAGE_MS = 2_000;

interface EditorContentElement extends HTMLElement {
  cmTile?: {
    root: {
      view: {
        state: { doc: { toString: () => string } };
        dispatch: (spec: { selection: { anchor: number } }) => void;
        focus: () => void;
      };
    };
  };
}

/** The message of each error that a window shows. */
function errorMessages(page: Page): Promise<string[]> {
  return page.locator(`${ERROR_TOAST} span:first-child`).allInnerTexts();
}

/** The errors of a window after the first one had time to get a second. */
async function settledErrorMessages(page: Page): Promise<string[]> {
  await page.locator(ERROR_TOAST).first().waitFor({ state: "visible", timeout: 20_000 });
  await delay(SECOND_MESSAGE_MS);
  return await errorMessages(page);
}

async function dismissErrors(page: Page): Promise<void> {
  const dismiss = page.locator(`${ERROR_TOAST} button[aria-label="Dismiss"]`);
  while ((await dismiss.count()) > 0) {
    await dismiss.first().click();
  }
}

async function findProjectPropertiesPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator("#formats-panel").count()) > 0) {
          return page;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No project-properties window appeared within ${timeoutMs}ms`);
}

describe("a refused change of Project settings", function () {
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

  before(async function () {
    const fixture = await createFixture("zettlr-project-settings-refusal-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    settingsFile = path.join(workspace, ".ztr-directory");
    await writeFile(settingsFile, JSON.stringify(PROJECT_SETTINGS), "utf8");
    await writeFile(path.join(workspace, "genus.md"), GENUS, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    // From here the settings file of the Project takes no write.
    await chmod(settingsFile, 0o400);
  });

  after(async function () {
    // The application quits when its last window closes, so the Project
    // properties window closes before the main window does.
    if (propertiesPage !== undefined && !propertiesPage.isClosed()) {
      const closed = propertiesPage.waitForEvent("close", { timeout: 10_000 });
      await propertiesPage.evaluate(() => {
        window.ipc.send("window-controls", { command: "win-close" });
      });
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

  it("shows one message when a completion cannot add its file to the Project", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    assert.deepEqual(await errorMessages(editorPage), [], "no error is shown at the start");

    const positioned = await editorPage.evaluate((target) => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) {
        throw new Error("the production editor exposes no CodeMirror view");
      }
      const at = view.state.doc.toString().indexOf(target);
      if (at < 0) {
        return false;
      }
      view.dispatch({ selection: { anchor: at + target.length } });
      view.focus();
      return true;
    }, "see @def");
    assert.equal(positioned, true, "the document holds the start of the reference");
    await editorPage.keyboard.press("Control+Space");
    const popup = editorPage.locator(".cm-tooltip-autocomplete");
    await popup.waitFor({ state: "visible", timeout: 20_000 });
    await popup.locator("li", { hasText: "def:genus-of-a-lattice" }).click();

    const messages = await settledErrorMessages(editorPage);
    screenshots.set("completion.png", await editorPage.screenshot());
    assert.deepEqual(messages, [NOT_SAVED], "the main window shows the cause one time");
    await dismissErrors(editorPage);
  });

  it("shows the cause in the Project properties window", async function () {
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

    await titleInput.fill("A title that cannot be saved");

    const messages = await settledErrorMessages(propertiesPage);
    screenshots.set("properties-window.png", await propertiesPage.screenshot());
    assert.deepEqual(messages, [NOT_SAVED], "the Project properties window shows the cause");
    assert.deepEqual(
      await errorMessages(editorPage),
      [],
      "the main window shows no message of a change that another window made",
    );
    await dismissErrors(propertiesPage);
  });

  it("shows why the window cannot change a folder that is no Project", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const properties = requireInitialized(propertiesPage, "The properties window must be open");
    await rm(settingsFile);
    await editorPage.waitForFunction(
      async (directoryPath) => {
        const descriptor = await window.ipc.invoke("fsal", {
          command: "get-descriptor",
          payload: directoryPath,
        });
        return (
          descriptor !== undefined &&
          !Array.isArray(descriptor) &&
          descriptor.type === "directory" &&
          descriptor.settings.project === null
        );
      },
      workspace,
      { timeout: 30_000 },
    );

    await properties.getByLabel("Project Title").fill("A title of no Project");

    const messages = await settledErrorMessages(properties);
    screenshots.set("no-project.png", await properties.screenshot());
    assert.deepEqual(messages, [NO_PROJECT], "the Project properties window shows the cause");
    assert.deepEqual(await errorMessages(editorPage), [], "the main window shows no message");
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a refused "Open workspace…"
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Open workspace…" refuses the home folder and a folder
 *                  that the built-in names hide. The refused folder does not
 *                  become a workspace, and the window shows one message that
 *                  names the folder.
 *
 *                  The app runs with a home folder of the fixture, so the
 *                  spec chooses that folder and no folder of the author. The
 *                  folder dialog is a native window: the spec answers it on
 *                  the X display of the run (`support/native-dialog.ts`). It
 *                  opens in the folder of `dialogPaths.askDirDialog`, and the
 *                  mnemonic of its Open button accepts that folder.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
import { captureWindow, nativeDialog, pressKey, searchWindows } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-open-workspace-refused-e2e-latest");
const FOLDER_DIALOG_TITLE = "Open workspace";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** The native message box that the unfixed command showed. */
const REFUSAL_BOX_TITLE = "Cannot open workpace";

/** The home folder of the author, which the fixture home borrows tools from. */
const AUTHOR_HOME = homedir();

describe("A refused Open workspace", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let home = "";
  let hidden = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** Waits until no window has this title. */
  async function closed(title: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while ((await searchWindows(["--name", `^${title}$`])).length > 0) {
      assert.ok(Date.now() < deadline, `the dialog "${title}" closed`);
      await delay(250);
    }
  }

  /** The workspaces of the configuration of the running app. */
  function openWorkspaces(editorPage: Page): Promise<string[]> {
    return editorPage.evaluate(() => {
      const config: unknown = window.ipc.sendSync("config-provider", { command: "get-config" });
      if (
        typeof config !== "object" ||
        config === null ||
        !("app" in config) ||
        typeof config.app !== "object" ||
        config.app === null ||
        !("openWorkspaces" in config.app) ||
        !Array.isArray(config.app.openWorkspaces)
      ) {
        throw new Error("The config provider returned no workspaces");
      }
      return config.app.openWorkspaces.map(String);
    });
  }

  /**
   * Chooses a folder in "Open workspace…" and waits for the first message:
   * an error toast in the window or a native message box.
   */
  async function chooseWorkspace(folder: string, capture: string): Promise<void> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const refusal: unknown = await editorPage.evaluate(
      (askDirDialog) =>
        window.ipc.sendSync("config-provider", {
          command: "set-config-single",
          payload: { key: "dialogPaths.askDirDialog", val: askDirDialog },
        }),
      folder,
    );
    assert.equal(refusal, null, "the dialog opens in the folder");
    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.open_workspace",
      });
    });
    const dialog = await nativeDialog(FOLDER_DIALOG_TITLE, 30_000);
    screenshots.set(`${capture}-dialog.png`, await captureWindow(dialog));
    await pressKey(dialog, "alt+o");
    await closed(FOLDER_DIALOG_TITLE);

    const deadline = Date.now() + 30_000;
    while (
      (await editorPage.locator(ERROR_TOAST).count()) === 0 &&
      (await searchWindows(["--name", `^${REFUSAL_BOX_TITLE}$`])).length === 0
    ) {
      assert.ok(Date.now() < deadline, "the refusal is shown before the time limit");
      await delay(250);
    }
    // The other messages of the same refusal arrive in the same task.
    await delay(2_000);
    screenshots.set(`${capture}.png`, await editorPage.screenshot());
  }

  /** Answers each native refusal box and gives how many there were. */
  async function dismissRefusalBoxes(): Promise<number> {
    const boxes = await searchWindows(["--name", `^${REFUSAL_BOX_TITLE}$`]);
    for (const box of boxes) {
      await pressKey(box, "Return");
    }
    await closed(REFUSAL_BOX_TITLE);
    return boxes.length;
  }

  /** Closes the error toasts of the window. */
  async function dismissToasts(editorPage: Page): Promise<void> {
    await editorPage.evaluate((selector) => {
      for (const toast of document.querySelectorAll(selector)) {
        toast.remove();
      }
    }, ERROR_TOAST);
  }

  before(async function () {
    const fixture = await createFixture("zettlr-open-workspace-refused-e2e-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo forms of one genus.\n",
    });
    fixtureRoot = fixture.root;
    // The home folder of the run holds the central Pandoc configuration of
    // the author, which the start of the app requires.
    home = path.join(fixture.root, "home");
    await mkdir(home);
    await symlink(path.join(AUTHOR_HOME, ".pandoc"), path.join(home, ".pandoc"));
    hidden = path.join(path.dirname(fixture.documentPath), ".git");
    await mkdir(hidden);
    await writeFile(path.join(hidden, "HEAD"), "ref: refs/heads/main\n");

    const app = await attach(fixture.configDirectory, rendererEvents, {
      environment: {
        HOME: home,
        // The Flowmark update of the start runs uv: it keeps the tools and
        // the cache of the author.
        UV_TOOL_DIR: path.join(AUTHOR_HOME, ".local", "share", "uv", "tools"),
        UV_TOOL_BIN_DIR: path.join(AUTHOR_HOME, ".local", "bin"),
        UV_CACHE_DIR: path.join(AUTHOR_HOME, ".cache", "uv"),
        UV_PYTHON_INSTALL_DIR: path.join(AUTHOR_HOME, ".local", "share", "uv", "python"),
      },
    });
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

  it("does not open the home folder and names it in one message", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");

    await chooseWorkspace(home, "home-refused");

    const workspaces = await openWorkspaces(editorPage);
    const boxes = await dismissRefusalBoxes();
    const toasts = await editorPage.locator(ERROR_TOAST).allInnerTexts();
    await dismissToasts(editorPage);
    assert.ok(!workspaces.includes(home), "the home folder is no workspace");
    assert.equal(boxes, 0, "the refusal is no native message box");
    assert.equal(toasts.length, 1, "one refusal shows one message");
    assert.ok(toasts[0].includes(home), "the message names the folder");
  });

  it("does not open a folder that the built-in names hide and names it in one message", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");

    await chooseWorkspace(hidden, "hidden-refused");

    const workspaces = await openWorkspaces(editorPage);
    const boxes = await dismissRefusalBoxes();
    const toasts = await editorPage.locator(ERROR_TOAST).allInnerTexts();
    await dismissToasts(editorPage);
    assert.ok(!workspaces.includes(hidden), "the hidden folder is no workspace");
    assert.equal(boxes + toasts.length, 1, "one refusal shows one message");
    assert.equal(toasts.length, 1, "the window shows the refusal");
    assert.ok(toasts[0].includes(hidden), "the message names the folder");
  });
});

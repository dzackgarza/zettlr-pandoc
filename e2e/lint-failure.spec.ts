/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a lint that did not run
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Three causes stop a lint, and the author gets each one
 *                  with the action that starts the lint again.
 *
 *                  1. No Flowmark run ends in the time limit of 1 ms. The
 *                     Problems view names each document with the cause, the
 *                     editor marks its document, and the status bar counts
 *                     the mark.
 *                  2. The file of the lint results takes no write. Each
 *                     reader of the results is refused: the Problems view
 *                     shows the cause, and the editor marks its document
 *                     with the same cause.
 *                  3. The installed Flowmark cannot be identified, so the
 *                     background queue lints no document. The Problems view
 *                     shows the cause.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  shutdown,
} from "./support/electron-app";

const INDEX = "Index of the notes.\n";
const PROBLEM = "Residue ???\n";
const TIME_LIMIT_CAUSE = "Markdown processing did not complete within 1 ms";
const USUAL_LIMIT_MS = 60_000;
const NOT_LINTED = "[data-problems-failed]";
const RETRY = "[data-problems-retry]";
const NOT_LOADED = "[data-problems-not-loaded]";
const QUEUE_STOPPED = "[data-problems-stopped]";
const EDITOR_ERROR = ".cm-content .cm-lintRange-error";
const STATUS_BAR_COUNTS = '[data-statusbar-item="diagnostics"]';

interface EditorContentElement extends HTMLElement {
  cmTile?: {
    root: {
      view: {
        state: { doc: { length: number } };
        dispatch: (spec: { changes: { from: number; insert: string } }) => void;
      };
    };
  };
}

/** The message of the error that the editor marks in its document. */
async function editorErrorMessage(page: Page): Promise<string> {
  const mark = page.locator(EDITOR_ERROR).first();
  await mark.waitFor({ state: "visible", timeout: 60_000 });
  await mark.hover();
  const diagnostic = page.locator(".cm-tooltip-lint .cm-diagnostic-error").first();
  await diagnostic.waitFor({ state: "visible", timeout: 20_000 });
  const message = await diagnostic.innerText();
  // The pointer leaves the document, so the tooltip covers no later step.
  await page.mouse.move(0, 0);
  return message;
}

/** Waits until the status bar counts this many errors in the document. */
async function statusBarCountsErrors(page: Page, errors: number): Promise<void> {
  const counts = async (): Promise<number[]> =>
    Array.from((await page.locator(STATUS_BAR_COUNTS).innerText()).matchAll(/\d+/g), (match) =>
      Number(match[0]),
    );
  const deadline = Date.now() + 10_000;
  // The item shows the counts of info, warning and error, in this order.
  while ((await counts())[2] !== errors) {
    assert.ok(
      Date.now() < deadline,
      `the status bar counts ${String(await counts())}, not ${errors} errors`,
    );
    await delay(200);
  }
}

async function setFlowmarkTimeLimit(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate(
    (val) =>
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: { key: "editor.lint.flowmark.timeoutMs", val },
      }),
    timeoutMs,
  );
}

function finding(page: Page, documentName: string): ReturnType<Page["locator"]> {
  return page
    .locator(".problems-group")
    .filter({ hasText: documentName })
    .locator(".problems-finding")
    .filter({ hasText: "document/authorial-residue" });
}

describe("a lint that did not run", function () {
  this.timeout(240_000);

  describe("a Flowmark run that fails, and results that cannot be written", function () {
    let appProcess: ChildProcess | undefined;
    let browser: Browser | undefined;
    let page: Page;
    let fixtureRoot: string | undefined;
    let workspace = "";
    let indexPath = "";
    let cachePath = "";
    let getOutput: () => string = () => "";
    const rendererEvents: string[] = [];
    const screenshots = new Map<string, Buffer>();

    before(async function () {
      const fixture = await createFixture("zettlr-lint-failure-e2e-", {
        documentName: "index.md",
        documentContents: INDEX,
        config: {
          darkMode: false,
          editor: { autoSave: "off", lint: { flowmark: { timeoutMs: 1 } } },
        },
      });
      fixtureRoot = fixture.root;
      indexPath = fixture.documentPath;
      workspace = path.dirname(indexPath);
      cachePath = path.join(fixture.configDirectory, "document-lint-cache.json");
      await writeFile(path.join(workspace, "problem.md"), PROBLEM, "utf8");
      const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
      appProcess = app.appProcess;
      browser = app.browser;
      getOutput = app.getOutput;
      page = await findEditorPage(app.browser, this.timeout());
      await hideDevServerOverlay(page);
      await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    });

    after(async function () {
      await shutdown(browser, appProcess);
      await preserveArtifacts(
        path.join(tmpdir(), "zettlr-lint-failure-e2e-latest"),
        fixtureRoot,
        getOutput(),
        rendererEvents,
        screenshots,
      );
      if (fixtureRoot !== undefined) {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
      assertCleanExit(getOutput());
    });

    it("names each document that Flowmark could not lint, with the cause", async function () {
      await page.locator('[data-activity="problems"]').click();
      const notLinted = page.locator(NOT_LINTED);
      await notLinted.waitFor({ state: "visible", timeout: 90_000 });
      for (const name of ["index.md", "problem.md"]) {
        const row = notLinted.locator(".problems-unlinted").filter({ hasText: name });
        await row.waitFor({ state: "visible", timeout: 90_000 });
        assert.match(
          await row.innerText(),
          new RegExp(TIME_LIMIT_CAUSE),
          `the view gives the cause for ${name}`,
        );
      }
      await page.locator("[data-problems-pending]").waitFor({ state: "detached", timeout: 30_000 });
      assert.equal(
        await page.getByText("No problems", { exact: true }).count(),
        0,
        "a workspace that was not linted is not a workspace without problems",
      );
      assert.equal(await notLinted.locator(RETRY).count(), 1, "the view offers the retry");
      assert.match(
        await editorErrorMessage(page),
        new RegExp(TIME_LIMIT_CAUSE),
        "the editor marks its document with the cause",
      );
      await statusBarCountsErrors(page, 1);
      screenshots.set("not-linted.png", await page.screenshot());
    });

    it("lints the documents again when the author asks for it", async function () {
      await setFlowmarkTimeLimit(page, USUAL_LIMIT_MS);
      await page.locator(NOT_LINTED).locator(RETRY).click();

      await finding(page, "problem.md").waitFor({ state: "visible", timeout: 90_000 });
      await page.locator(NOT_LINTED).waitFor({ state: "detached", timeout: 30_000 });
      await page.locator(EDITOR_ERROR).waitFor({ state: "detached", timeout: 60_000 });
      await statusBarCountsErrors(page, 0);
      screenshots.set("linted-after-retry.png", await page.screenshot());
    });

    it("shows why no lint runs while the results cannot be written", async function () {
      // The results of both documents are in the file, so no write waits.
      const deadline = Date.now() + 30_000;
      const resultsWritten = async (): Promise<boolean> =>
        await readFile(cachePath, "utf8").then(
          (contents) => contents.includes("index.md") && contents.includes("problem.md"),
          () => false,
        );
      while (!(await resultsWritten())) {
        assert.ok(Date.now() < deadline, "the results of the two documents were not written");
        await delay(200);
      }
      // A directory is in the place of the file: the next write fails.
      await rm(cachePath);
      await mkdir(cachePath);
      await writeFile(path.join(workspace, "late.md"), "Late ???\n", "utf8");

      const notLoaded = page.locator(NOT_LOADED);
      await notLoaded.waitFor({ state: "visible", timeout: 90_000 });
      const cause = await notLoaded.locator("p").innerText();
      assert.ok(
        cause.startsWith(`Could not write the lint results to ${cachePath}: `),
        `the view names the file and the cause: ${cause}`,
      );
      assert.equal(await notLoaded.locator(RETRY).count(), 1, "the view offers the retry");

      // An edit starts the lint of the editor, which is refused too.
      await page.evaluate(() => {
        const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
        if (view === undefined) {
          throw new Error("the production editor exposes no CodeMirror view");
        }
        view.dispatch({ changes: { from: view.state.doc.length, insert: "One more line.\n" } });
      });
      const editorMessage = await editorErrorMessage(page);
      assert.ok(
        editorMessage.includes(cause),
        `the editor gives the cause of the view: ${editorMessage}`,
      );
      screenshots.set("results-not-written.png", await page.screenshot());

      await rm(cachePath, { recursive: true });
      await notLoaded.locator(RETRY).click();
      await finding(page, "late.md").waitFor({ state: "visible", timeout: 90_000 });
      await notLoaded.waitFor({ state: "detached", timeout: 30_000 });
      await page.locator(EDITOR_ERROR).waitFor({ state: "detached", timeout: 60_000 });

      // A document with unsaved text stops the close of the window with a
      // native prompt. This is the IPC call that the save-file shortcut
      // makes: CDP key events do not reach the accelerators of the menu.
      const saved = await page.evaluate(
        async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
        indexPath,
      );
      assert.deepEqual(saved, { ok: true }, "the edited document is saved");
    });
  });

  describe("a Flowmark install that cannot be identified", function () {
    let appProcess: ChildProcess | undefined;
    let browser: Browser | undefined;
    let page: Page;
    let fixtureRoot: string | undefined;
    let getOutput: () => string = () => "";
    const rendererEvents: string[] = [];
    const screenshots = new Map<string, Buffer>();

    before(async function () {
      const fixture = await createFixture("zettlr-lint-no-flowmark-e2e-", {
        documentName: "index.md",
        documentContents: PROBLEM,
        config: { darkMode: true, editor: { autoSave: "off" } },
      });
      fixtureRoot = fixture.root;
      // uv has no Flowmark in these directories. Without a network and
      // with an empty cache it installs none, so the update at the start
      // of the app fails. The tools of the workstation stay as they are.
      const toolDirectory = path.join(fixture.root, "uv-tools");
      const toolBinDirectory = path.join(fixture.root, "uv-tool-bin");
      const cacheDirectory = path.join(fixture.root, "uv-cache");
      await mkdir(toolDirectory);
      await mkdir(toolBinDirectory);
      await mkdir(cacheDirectory);
      const app = await attach(fixture.configDirectory, rendererEvents, this.timeout(), {
        environment: {
          UV_TOOL_DIR: toolDirectory,
          UV_TOOL_BIN_DIR: toolBinDirectory,
          UV_CACHE_DIR: cacheDirectory,
          UV_OFFLINE: "1",
        },
      });
      appProcess = app.appProcess;
      browser = app.browser;
      getOutput = app.getOutput;
      page = await findEditorPage(app.browser, this.timeout());
      await hideDevServerOverlay(page);
      await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    });

    after(async function () {
      await shutdown(browser, appProcess);
      await preserveArtifacts(
        path.join(tmpdir(), "zettlr-lint-no-flowmark-e2e-latest"),
        fixtureRoot,
        getOutput(),
        rendererEvents,
        screenshots,
      );
      if (fixtureRoot !== undefined) {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
      assertCleanExit(getOutput());
    });

    it("shows why the background queue lints no document", async function () {
      await page.locator('[data-activity="problems"]').click();
      const stopped = page.locator(QUEUE_STOPPED);
      await stopped.waitFor({ state: "visible", timeout: 90_000 });
      assert.match(
        await stopped.locator("p").innerText(),
        /Cannot identify the installed Flowmark/,
        "the view gives the cause",
      );
      assert.equal(await stopped.locator(RETRY).count(), 1, "the view offers the retry");
      assert.equal(
        await page.getByText("No problems", { exact: true }).count(),
        0,
        "a workspace that is not linted is not a workspace without problems",
      );
      screenshots.set("queue-stopped-dark.png", await page.screenshot());
    });
  });
});

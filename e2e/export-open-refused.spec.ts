/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of an export whose file the desktop does not open
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     After an export the application opens the exported file
 *                  with the application of the desktop, and a click on the
 *                  finished task opens it again. Here the desktop opens
 *                  nothing: the `xdg-open` of the run stops with an error.
 *                  The export is a success all the same, the command
 *                  answers, and each refused open gives the author one
 *                  error window that names the file.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import type { PandocProfileMetadata } from "source/app/service-providers/assets";
import {
  assertCleanExit,
  attach,
  clickToClose,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-export-open-refused-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const PROFILE = "Plain Text.yaml";

/** The status of a finished task (`TaskStatus.finished`). */
const FINISHED = 1;

/** The time in which a second error window of one open appears. */
const SECOND_WINDOW_MS = 2_000;

/** Each open error window of the application. */
async function errorWindows(browser: Browser): Promise<Page[]> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const counts = await Promise.all(pages.map(async (page) => await page.locator("#error").count()));
  return pages.filter((_page, index) => counts[index] > 0);
}

/**
 * The one error window that appears within the time limit. The function
 * waits for a second window and fails when one appears.
 */
async function onlyErrorWindow(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while ((await errorWindows(browser)).length === 0) {
    assert.ok(Date.now() < deadline, `no error window appeared within ${timeoutMs}ms`);
    await delay(100);
  }
  await delay(SECOND_WINDOW_MS);
  const open = await errorWindows(browser);
  assert.equal(open.length, 1, "one refused open opens one error window");
  await open[0].locator("#error").waitFor({ state: "visible", timeout: 20_000 });
  return open[0];
}

/** Closes an error window with its button. */
async function closeErrorWindow(shown: Page): Promise<void> {
  await clickToClose(shown, shown.getByRole("button", { name: "Ok" }));
}

/** What `get-tasks` of the task provider answers for one task. */
interface TaskState {
  id: string;
  title: string;
  status: number;
  interactable: boolean;
}

describe("an export whose file the desktop does not open", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let document = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-export-open-refused-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { darkMode: false, export: { dir: "cwd", autoOpenExportedFiles: true } },
    });
    fixtureRoot = fixture.root;
    document = fixture.documentPath;
    workspace = path.dirname(document);

    // The desktop of the run opens nothing.
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    const xdgOpen = path.join(bin, "xdg-open");
    await writeFile(xdgOpen, '#!/bin/sh\necho "no application opens $1" >&2\nexit 4\n', "utf8");
    await chmod(xdgOpen, 0o755);

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout(), {
      environment: { PATH: `${bin}:${process.env.PATH}` },
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

  /** The tasks of the task provider. */
  async function tasks(): Promise<TaskState[]> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    return await editorPage.evaluate(
      async () => await window.ipc.invoke("lrt-provider", { command: "get-tasks" }),
    );
  }

  it("exports the document and names the file that it could not open", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const runningBrowser = requireInitialized(browser, "The application must be running");
    const exported = path.join(workspace, "note.txt");

    // The call that the export launcher of the main window makes.
    await editorPage.evaluate(
      async ({ file, name }) => {
        const profiles: PandocProfileMetadata[] = await window.ipc.invoke("assets-provider", {
          command: "list-export-profiles",
        });
        const profile = profiles.find((candidate) => candidate.name === name);
        if (profile === undefined || profile.isInvalid) {
          throw new Error(`The application has no valid profile ${name}`);
        }
        await window.ipc.invoke("application", {
          command: "export",
          payload: { file, profile, exportTo: "cwd" },
        });
      },
      { file: document, name: PROFILE },
    );

    assert.equal(existsSync(exported), true, "the document was exported");
    const shown = await onlyErrorWindow(runningBrowser, 30_000);
    screenshots.set("export-open-refused.png", await shown.screenshot());
    const text = await shown.locator("#error").innerText();
    assert.ok(text.includes(exported), `the error window does not name ${exported}:\n${text}`);
    await closeErrorWindow(shown);

    const [task] = (await tasks()).filter((candidate) => candidate.title.includes("note.md"));
    assert.equal(task.status, FINISHED, "the export is a finished task, not a failed one");
  });

  it("names the file when a click on the finished export cannot open it", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const runningBrowser = requireInitialized(browser, "The application must be running");
    const exported = path.join(workspace, "note.txt");
    const [task] = (await tasks()).filter((candidate) => candidate.title.includes("note.md"));
    assert.equal(task.interactable, true);

    // The click on a finished task in the task list.
    await editorPage.evaluate((id) => {
      window.ipc.send("lrt-provider", { command: "interact-task", payload: { id } });
    }, task.id);

    const shown = await onlyErrorWindow(runningBrowser, 30_000);
    screenshots.set("task-open-refused.png", await shown.screenshot());
    const text = await shown.locator("#error").innerText();
    assert.ok(text.includes(exported), `the error window does not name ${exported}:\n${text}`);
    await closeErrorWindow(shown);
  });
});

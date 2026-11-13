/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a Project export with failed profiles
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The workspace is a Project with three export commands.
 *                  Two of them stop with an error. The author gets one error
 *                  window that names each command that did not export, with
 *                  its cause, and the third command still exports.
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
  clickToClose,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-project-export-failure-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";

/** What the first failing command writes to its error output. */
const NO_ENGINE = "the engine of the first command is absent";

/** What the second failing command writes to its error output. */
const NO_TEMPLATE = "the template of the second command is absent";

/**
 * The export commands of the configuration. The application gives a command
 * the Project folder as its one argument.
 */
const COMMANDS = [
  { displayName: "First command", command: `sh -c 'echo "${NO_ENGINE}" >&2; exit 3' sh` },
  { displayName: "Second command", command: `sh -c 'echo "${NO_TEMPLATE}" >&2; exit 4' sh` },
  { displayName: "Listing", command: `sh -c 'ls "$1" > "$1/listing.txt"' sh` },
];

/** The time in which a second error window of one export opens. */
const SECOND_WINDOW_MS = 2_000;

/** Each open error window of the application. */
async function errorWindows(browser: Browser): Promise<Page[]> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const counts = await Promise.all(pages.map(async (page) => await page.locator("#error").count()));
  return pages.filter((_page, index) => counts[index] > 0);
}

async function firstErrorWindow(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [open] = await errorWindows(browser);
    if (open !== undefined) {
      return open;
    }
    await delay(100);
  }
  throw new Error(`No error window appeared within ${timeoutMs}ms`);
}

describe("a Project export with profiles that did not export", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-project-export-failure-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { darkMode: false, export: { customCommands: COMMANDS } },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    await writeFile(
      path.join(workspace, ".ztr-directory"),
      JSON.stringify({
        sorting: "name-up",
        project: {
          title: "Lattices",
          profiles: COMMANDS.map((command) => command.command),
          files: ["note.md"],
          cslStyle: "",
          templates: { tex: "", html: "" },
        },
        icon: null,
        color: null,
      }),
      "utf8",
    );
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

  it("names each profile that did not export in one error window", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const runningBrowser = requireInitialized(browser, "The application must be running");

    // The call that "Build project" of the file manager makes.
    const exported = await editorPage.evaluate(
      async (payload) =>
        await window.ipc.invoke("application", { command: "dir-project-export", payload }),
      workspace,
    );

    const errorWindow = await firstErrorWindow(runningBrowser, 30_000);
    await delay(SECOND_WINDOW_MS);
    const open = await errorWindows(runningBrowser);
    assert.equal(open.length, 1, "one export opens one error window");
    const shown = open[0];
    await shown.locator("#error").waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("error-window.png", await shown.screenshot());
    const text = await shown.locator("#error").innerText();
    for (const part of ["First command", "Second command", NO_ENGINE, NO_TEMPLATE]) {
      assert.ok(text.includes(part), `the error window has no "${part}":\n${text}`);
    }
    assert.equal(exported, false, "the command answers that the Project did not export");
    assert.match(
      await readFile(path.join(workspace, "listing.txt"), "utf8"),
      /^note\.md$/m,
      "the command that can run exported the Project",
    );

    // The application quits when its last window closes, so the error
    // window closes before the main window does.
    await clickToClose(shown, shown.getByRole("button", { name: "Ok" }));
    assert.equal(errorWindow.isClosed(), true);
  });
});

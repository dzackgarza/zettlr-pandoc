// Proof that a global search over a workspace that went away ends, and says in
// the pane which folder it did not search.
//
// Starting a search puts the pane into its running presentation — progress bar
// up, previous results cleared — and then dispatches over IPC. Only the search
// provider ends that state. A workspace that goes away while the app is
// running stays in `app.openWorkspaces`: the dead-path sweep runs once, when
// the config is read at boot, and FSAL keeps such roots afterwards. A user
// whose workspace lives on a drive that unmounts, or a synced folder that
// disappears, searches with such a root open. The search reads the other
// workspaces, names the root that it could not list (`search-unread`), and
// ends.
import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
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
  preserveArtifacts,
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

declare global {
  interface Window {
    /** "<generation> <type>" of each search broadcast, in the order of arrival. */
    searchBroadcasts: string[];
  }
}

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-global-search-dispatch-failure-e2e-latest");

/** The pane, and the parts of it this spec reads. */
const PANE = "#search-view";
const QUERY_INPUT = `${PANE} input[name="search-input"]`;
const RUNNING_INDICATOR = `${PANE} .search-progress`;
const ERROR_MESSAGE = `${PANE} p.search-message-error`;
const REPLACEMENT_RESULT = `${PANE} .file-match .file-match-name`;
const NOT_SEARCHED = `${PANE} [data-search-not-searched]`;

const PROJECT_SETTINGS = {
  sorting: "name-up",
  project: {
    title: "Initial project",
    profiles: [],
    files: [],
    cslStyle: "",
    templates: { tex: "", html: "" },
  },
  icon: null,
  color: null,
};

// The first query of the spec reads each of these files: enough files that
// the search still runs when the edited query starts. LaTeX files are searched
// and not linted, so the background lint does not take the time of the specs.
const SEARCH_CORPUS_FILES = 1024;
const CORPUS_TEXT = `ordinary ${"filler words ".repeat(120)}`;

interface RunningFixture {
  appProcess: ChildProcess | undefined;
  browser: Browser | undefined;
  fixtureRoot: string | undefined;
  workspace: string | undefined;
  projectSettingsFile: string | undefined;
  vanishingWorkspace: string | undefined;
  getOutput: () => string;
  rendererEvents: string[];
  screenshots: Map<string, Buffer>;
  /** The Project properties window that a test opened. */
  propertiesPage: Page | undefined;
}

/**
 * Boots the app with two workspaces open: the fixture's own, and a second one
 * this spec later deletes out from under the running app. Both must exist at
 * boot, because the config drops workspaces that are already missing when it is
 * read. createFixture writes the config before it knows the second path, so
 * that path is merged into the file it produced rather than by widening the
 * shared harness.
 */
async function boot(fixture: RunningFixture): Promise<void> {
  const created = await createFixture("zettlr-global-search-dispatch-failure-e2e-", {
    documentName: "searched-document.md",
    documentContents: "# Searchable\n\nThe word haystack appears here.\n",
    // The app lists the LaTeX files of the corpus.
    config: { fileManager: { filters: { include: [".md", ".tex"] } } },
  });
  fixture.fixtureRoot = created.root;
  const workspace = path.dirname(created.documentPath);
  fixture.workspace = workspace;
  const projectSettingsFile = path.join(workspace, ".ztr-directory");
  fixture.projectSettingsFile = projectSettingsFile;
  await writeFile(projectSettingsFile, JSON.stringify(PROJECT_SETTINGS), "utf8");

  for (let index = 0; index < SEARCH_CORPUS_FILES; index += 1) {
    await writeFile(
      path.join(workspace, `search-corpus-${String(index).padStart(4, "0")}.tex`),
      `% Corpus ${index}\n\n${CORPUS_TEXT}\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(workspace, "replacement-hit.md"),
    "# Replacement\n\nreplacementtoken appears here.\n",
    "utf8",
  );

  const vanishingWorkspace = path.join(created.root, "workspace-on-a-removable-drive");
  await mkdir(vanishingWorkspace);
  await writeFile(
    path.join(vanishingWorkspace, "note-on-the-drive.md"),
    "# On the drive\n\nAnother haystack lives here.\n",
    "utf8",
  );
  fixture.vanishingWorkspace = vanishingWorkspace;

  const configPath = path.join(created.configDirectory, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    app: { openWorkspaces: string[] };
  };
  config.app.openWorkspaces = [...config.app.openWorkspaces, vanishingWorkspace];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const app = await attach(created.configDirectory, fixture.rendererEvents);
  fixture.appProcess = app.appProcess;
  fixture.browser = app.browser;
  fixture.getOutput = app.getOutput;
}

async function teardown(fixture: RunningFixture): Promise<void> {
  // The application quits when its last window closes, so the Project
  // properties window closes before the main window does.
  const propertiesPage = fixture.propertiesPage;
  if (propertiesPage !== undefined && !propertiesPage.isClosed()) {
    const closed = propertiesPage.waitForEvent("close", { timeout: 10_000 });
    await requestWindowClose(propertiesPage);
    await closed;
  }
  await shutdown(fixture.browser, fixture.appProcess);
  await preserveArtifacts(
    ARTIFACT_DIRECTORY,
    fixture.fixtureRoot,
    fixture.getOutput(),
    fixture.rendererEvents,
    fixture.screenshots,
  );
  if (fixture.fixtureRoot !== undefined) {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
  console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
  assertCleanExit(fixture.getOutput());
}

/** Opens the global search pane the way a user does: the Search all files menu item. */
async function openSearchPane(page: Page, timeoutMs: number): Promise<void> {
  const queryInput = page.locator(QUERY_INPUT);
  if (!(await queryInput.isVisible())) {
    await page.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.find_dir" });
    });
    await queryInput.waitFor({ state: "visible", timeout: timeoutMs });
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

async function waitForProjectState(
  page: Page,
  workspace: string,
  shouldBeProject: boolean,
): Promise<void> {
  await page.waitForFunction(
    async ({ directoryPath, enabled }) => {
      const descriptor = await window.ipc.invoke("fsal", {
        command: "get-descriptor",
        payload: directoryPath,
      });
      return (
        descriptor !== undefined &&
        !Array.isArray(descriptor) &&
        descriptor.type === "directory" &&
        (descriptor.settings.project !== null) === enabled
      );
    },
    { directoryPath: workspace, enabled: shouldBeProject },
    { timeout: 30_000 },
  );
}

async function waitForProcessOutput(
  getOutput: () => string,
  fragment: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getOutput().includes(fragment)) {
      return;
    }
    await delay(100);
  }
  assert.fail(`Application log never reported ${JSON.stringify(fragment)}`);
}

async function waitForProjectTitle(
  settingsFile: string,
  expectedTitle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let settings: unknown;
    try {
      settings = JSON.parse(await readFile(settingsFile, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        await delay(100);
        continue;
      }
      throw error;
    }
    if (
      settings !== null &&
      typeof settings === "object" &&
      "project" in settings &&
      settings.project !== null &&
      typeof settings.project === "object" &&
      "title" in settings.project &&
      settings.project.title === expectedTitle
    ) {
      return;
    }
    await delay(100);
  }
  assert.fail(`Project settings never persisted title ${JSON.stringify(expectedTitle)}`);
}

describe("global-search and project-properties failure recovery", function () {
  const running: RunningFixture = {
    appProcess: undefined,
    browser: undefined,
    fixtureRoot: undefined,
    workspace: undefined,
    projectSettingsFile: undefined,
    vanishingWorkspace: undefined,
    getOutput: () => "",
    rendererEvents: [],
    screenshots: new Map<string, Buffer>(),
    propertiesPage: undefined,
  };
  const { screenshots } = running;

  before(async function () {
    await boot(running);
  });

  after(async function () {
    await teardown(running);
  });

  it("starts the edited query after cancelling the active search", async function () {
    assert.ok(running.browser, "The application must be running");
    const page = await findEditorPage(running.browser, this.timeout());
    await openSearchPane(page, 30_000);
    await page.evaluate(() => {
      window.searchBroadcasts = [];
      window.ipc.on("search-provider", (_event, message) => {
        window.searchBroadcasts.push(`${message.generation} ${message.type}`);
      });
    });

    // The first query matches each corpus file. The edited query starts at
    // the first result of the first, while the first still reads the corpus.
    const queryInput = page.locator(QUERY_INPUT);
    await queryInput.fill("ordinary");
    await queryInput.press("Enter");
    await page.waitForFunction(
      () => window.searchBroadcasts.some((entry) => entry.endsWith(" search-result")),
      undefined,
      { polling: "raf", timeout: 60_000 },
    );
    await queryInput.fill("replacementtoken");
    await queryInput.press("Enter");
    // The pane labels a result with the name of its file.
    await page
      .locator(REPLACEMENT_RESULT)
      .filter({
        hasText: "replacement-hit.md",
      })
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(RUNNING_INDICATOR).waitFor({ state: "hidden", timeout: 60_000 });
    screenshots.set("search-edited-query.png", await page.screenshot());
    const broadcasts = await page.evaluate(() => window.searchBroadcasts);
    // A corpus result here is a result of the first query that the edited
    // query did not cancel. The list keeps rows that it does not show.
    assert.deepEqual(
      await page.locator(REPLACEMENT_RESULT).filter({ visible: true }).allInnerTexts(),
      ["replacement-hit.md"],
      "the pane shows only the result of the edited query",
    );

    const generations = [...new Set(broadcasts.map((entry) => entry.split(" ")[0]))];
    assert.equal(generations.length, 2, "one search for each query");
    const [first, edited] = generations.map((generation) =>
      broadcasts
        .filter((entry) => entry.split(" ")[0] === generation)
        .map((entry) => entry.split(" ")[1]),
    );
    // The edited query replaced a search that still ran: the first search
    // sent results and never its end.
    assert.ok(first.includes("search-result"), "the first search sent results");
    assert.ok(
      !first.includes("search-end"),
      "the first search was still running when the edited query started",
    );
    // The edited search ends one time, after each of its other messages: an
    // end before them hides the running presentation while it still reads.
    assert.equal(
      edited.filter((type) => type === "search-end").length,
      1,
      "the edited search ends one time",
    );
    assert.equal(edited.at(-1), "search-end", "the end of the edited search is its last message");
  });

  it("retries a project edit after descriptor validation recovers", async function () {
    const workspace = requireInitialized(
      running.workspace,
      "The fixture workspace must be initialized",
    );
    const projectSettingsFile = requireInitialized(
      running.projectSettingsFile,
      "The project settings path must be initialized",
    );
    assert.ok(running.browser, "The application must be running");
    const mainPage = await findEditorPage(running.browser, this.timeout());

    // The Project module hosts the file manager; it may be collapsed or the
    // sidebar hidden after the preceding tests, so reveal it through the
    // Search files menu item before opening the workspace context menu.
    if (!(await mainPage.locator("#file-manager").isVisible())) {
      await mainPage.evaluate(() => {
        window.ipc.send("menu-provider", {
          command: "click-menu-item",
          payload: "menu.filter_files",
        });
      });
      await mainPage.locator("#file-manager").waitFor({
        state: "visible",
        timeout: 10_000,
      });
    }

    // Reach Project Settings through the directory's real context-menu path.
    // On Linux the menu is rendered in the same Electron page, so the native
    // right-click event and the production menu callback are both observable.
    const workspaceItem = mainPage.locator(
      `.tree-item.directory[data-path=${JSON.stringify(workspace)}]`,
    );
    await workspaceItem.waitFor({ state: "visible", timeout: 30_000 });
    await workspaceItem.click({ button: "right" });
    const propertiesItem = mainPage.locator(
      '.application-menu .menu-item[data-id="menu.properties"]',
    );
    await propertiesItem.waitFor({ state: "visible", timeout: 10_000 });
    await propertiesItem.click();
    await mainPage.locator(".popover").waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("directory-properties.png", await mainPage.screenshot());
    const projectSettingsButton = mainPage.getByRole("button", {
      name: "Project Settings…",
      exact: true,
    });
    await projectSettingsButton.waitFor({ state: "visible", timeout: 10_000 });
    await projectSettingsButton.click();

    const propertiesPage = await findProjectPropertiesPage(running.browser, 30_000);
    running.propertiesPage = propertiesPage;
    const titleInput = propertiesPage.getByLabel("Project Title");
    await titleInput.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await titleInput.inputValue(), "Initial project");

    await rm(projectSettingsFile);
    await waitForProjectState(mainPage, workspace, false);
    await titleInput.fill("First edit cannot persist");
    // The main process logs the refused edit.
    await waitForProcessOutput(running.getOutput, "this folder is no longer a Project", 30_000);

    await writeFile(projectSettingsFile, JSON.stringify(PROJECT_SETTINGS), "utf8");
    await waitForProjectState(mainPage, workspace, true);
    await titleInput.fill("Recovered project title");
    await waitForProjectTitle(projectSettingsFile, "Recovered project title", 10_000);

    // The next test sends menu items to the main window, which must hold the focus.
    const closed = propertiesPage.waitForEvent("close", { timeout: 10_000 });
    await requestWindowClose(propertiesPage);
    await closed;
  });

  it("names a workspace that went away as not searched, and shows the matches of the others", async function () {
    const vanishingWorkspace = requireInitialized(
      running.vanishingWorkspace,
      "The vanishing workspace path must be initialized",
    );
    assert.ok(running.browser, "The application must be running");
    const page = await findEditorPage(running.browser, this.timeout());
    await openSearchPane(page, 30_000);

    // The drive goes away with the app already up, so the vanished root is
    // still an open workspace when the search provider reads it.
    await rm(vanishingWorkspace, { recursive: true, force: true });

    await page.locator(QUERY_INPUT).fill("haystack");
    await page.locator(QUERY_INPUT).press("Enter");

    // The pane names the root that the search could not list, and the search
    // ends: no progress bar stays up for it.
    const unsearched = page.locator(`${NOT_SEARCHED} li[data-path="${vanishingWorkspace}"]`);
    await unsearched.waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(RUNNING_INDICATOR).waitFor({ state: "detached", timeout: 30_000 });
    screenshots.set("search-vanished-workspace.png", await page.screenshot());

    assert.equal(
      await page.locator(`${NOT_SEARCHED} li`).count(),
      1,
      "The pane names the one folder that the search could not list.",
    );
    assert.equal(
      await page.locator(ERROR_MESSAGE).count(),
      0,
      "A workspace that the search could not list is no failure of the search.",
    );
    // The match of the workspace that is still there.
    assert.deepEqual(await page.locator(REPLACEMENT_RESULT).allInnerTexts(), [
      "searched-document.md",
    ]);

    // The list belongs to one search: clearing the search takes it away.
    await page.locator(`${PANE} [data-search-action="clear"]`).click();
    await unsearched.waitFor({ state: "detached", timeout: 10_000 });
  });
});

/**
 * Assembled-app proof of the file filters: a gitignore rule removes the files
 * and folders it matches from the file manager and from the Agent API
 * listing, the file manager itself edits the rules, and a changed rule
 * changes the open tree with no restart.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import {
  type AgentClient,
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  readAgentApiPort,
  shutdown,
} from "./support/electron-app";

const GLOBAL_RULES = ["*scripts*", "*_files/", "references/", "AGENTS.md"];

/** Each file of the workspace besides the open document, relative to its root. */
const FILES = [
  "AGENTS.md",
  "scripts/plot.md",
  "coble/notes.md",
  "coble/AGENTS.md",
  "coble/CONTRIBUTING.md",
  "coble/scripts/run.md",
  "coble/Roadmap_files/figure.md",
  "coble/references/paper.md",
  "coble/drafts/old.md",
];

const DIALOG = "[data-ignore-rules-dialog]";
const MENU_ITEM = (id: string): string =>
  `.application-menu .menu-item[data-id=${JSON.stringify(id)}]`;

describe("assembled app: gitignore rules filter the workspace", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let api: AgentClient | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  function activePage(): Page {
    assert.ok(page !== undefined, "The editor window must be open");
    return page;
  }

  function row(relativePath: string): Locator {
    const absPath = path.join(workspace, relativePath);
    return activePage().locator(`#file-manager .tree-item[data-path=${JSON.stringify(absPath)}]`);
  }

  async function expand(relativePath: string): Promise<void> {
    await row(relativePath).locator(".item-icon").click();
  }

  async function assertListed(relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      await row(relativePath).waitFor({ state: "visible", timeout: 15_000 });
    }
  }

  async function assertNotListed(relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      await row(relativePath).waitFor({ state: "detached", timeout: 15_000 });
    }
  }

  /** Opens the menu of the Workspaces header of the file manager. */
  async function openHeaderMenu(): Promise<void> {
    await activePage().locator("#directories-dirs-header .root-settings").click();
    await activePage()
      .locator(MENU_ITEM("explorer-edit-ignore-rules"))
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  /** Flips "Turn the filters off" in the file filter window and saves. */
  async function toggleFiltersOff(): Promise<void> {
    await openHeaderMenu();
    await activePage().locator(MENU_ITEM("explorer-edit-ignore-rules")).click();
    await activePage().locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    await activePage().locator(`${DIALOG} [data-ignore-rules-show-ignored]`).click();
    await activePage().locator(`${DIALOG} [data-ignore-rules-save]`).click();
    await activePage().locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });
  }

  async function openContextMenu(relativePath: string): Promise<void> {
    await row(relativePath).click({ button: "right" });
    await activePage().locator(".application-menu").waitFor({ state: "visible", timeout: 10_000 });
  }

  /** The files the Agent API lists, relative to the workspace root, sorted. */
  async function apiFiles(): Promise<string[]> {
    assert.ok(api !== undefined, "The Agent API must be reachable");
    const listing = (await api.get("/v1/workspaces?include=files")) as {
      files: Array<{ path: string }>;
    };
    return listing.files.map((file) => path.relative(workspace, file.path)).sort();
  }

  async function waitForApiFiles(expected: string[]): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (JSON.stringify(await apiFiles()) === JSON.stringify(expected)) {
        return;
      }
      await delay(150);
    }
    assert.deepEqual(await apiFiles(), expected);
  }

  async function waitForRulesFile(expected: string): Promise<void> {
    const rulesFile = path.join(workspace, ".zettlrignore");
    const read = async (): Promise<string> => await readFile(rulesFile, "utf8");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await read()) === expected) {
        return;
      }
      await delay(150);
    }
    assert.equal(await read(), expected);
  }

  before(async function () {
    const fixture = await createFixture("zettlr-ignore-rules-e2e-", {
      documentName: "index.md",
      documentContents: "# Index\n",
      config: {
        darkMode: false,
        agentApi: { enabled: true, port: 0 },
        window: { fileManagerVisible: true, sidebarVisible: true },
        fileManager: { ignoreRules: GLOBAL_RULES },
      },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    for (const relativePath of FILES) {
      const filePath = path.join(workspace, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `# ${path.basename(relativePath, ".md")}\n`, "utf8");
    }

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    api = agentClient(await readAgentApiPort(fixture.configDirectory, 60_000));
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    await page.setViewportSize({ width: 1500, height: 950 });
  });

  after(async function () {
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-ignore-rules-e2e-latest"),
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

  it("lists no file and no folder that a rule matches", async function () {
    await assertListed(["index.md", "coble"]);
    await expand("coble");
    await assertListed(["coble/notes.md", "coble/CONTRIBUTING.md", "coble/drafts"]);
    await expand("coble/drafts");
    await assertListed(["coble/drafts/old.md"]);
    await assertNotListed([
      "AGENTS.md",
      "scripts",
      "coble/AGENTS.md",
      "coble/scripts",
      "coble/Roadmap_files",
      "coble/references",
    ]);
    assert.deepEqual(await apiFiles(), [
      "coble/CONTRIBUTING.md",
      "coble/drafts/old.md",
      "coble/notes.md",
      "index.md",
    ]);
    screenshots.set("filtered-tree.png", await activePage().screenshot());
  });

  it("saves a workspace rule from the menu of the Workspaces header, and the open tree follows", async function () {
    await openHeaderMenu();
    screenshots.set("header-menu.png", await activePage().screenshot());
    await activePage().locator(MENU_ITEM("explorer-edit-ignore-rules")).click();
    await activePage().locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await activePage().locator(`${DIALOG} [data-ignore-rules-global]`).inputValue(),
      GLOBAL_RULES.join("\n"),
      "the dialog shows the rules for all workspaces",
    );

    await activePage()
      .locator(`${DIALOG} [data-ignore-rules-workspace=${JSON.stringify(workspace)}]`)
      .fill("CONTRIBUTING.md");
    screenshots.set("dialog.png", await activePage().screenshot());
    await activePage().locator(`${DIALOG} [data-ignore-rules-save]`).click();
    await activePage().locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });

    await waitForRulesFile("CONTRIBUTING.md\n");
    await assertNotListed(["coble/CONTRIBUTING.md"]);
    await assertListed(["coble/notes.md"]);
    await waitForApiFiles(["coble/drafts/old.md", "coble/notes.md", "index.md"]);
  });

  it("hides one folder from its context menu with a rule for that path", async function () {
    await openContextMenu("coble/drafts");
    screenshots.set("context-menu.png", await activePage().screenshot());
    await activePage().locator(MENU_ITEM("menu.ignore_path")).click();

    await waitForRulesFile("CONTRIBUTING.md\n/coble/drafts/\n");
    await assertNotListed(["coble/drafts", "coble/drafts/old.md"]);
    await waitForApiFiles(["coble/notes.md", "index.md"]);
  });

  it("turns the filters off everywhere and dims the matches, and shows one again from its context menu", async function () {
    await toggleFiltersOff();
    await assertListed([
      "AGENTS.md",
      "scripts",
      "coble/drafts",
      "coble/CONTRIBUTING.md",
      "coble/references",
    ]);
    await waitForApiFiles(["index.md", ...FILES].sort());
    const isMarked = async (relativePath: string): Promise<boolean> =>
      await row(relativePath).evaluate((element) => element.classList.contains("is-ignored"));
    for (const hidden of ["AGENTS.md", "scripts", "coble/drafts", "coble/references"]) {
      assert.ok(await isMarked(hidden), `${hidden} is marked as hidden`);
    }
    assert.ok(!(await isMarked("coble/notes.md")), "a listed file is not marked");
    screenshots.set("hidden-shown.png", await activePage().screenshot());

    await expand("scripts");
    await openContextMenu("scripts/plot.md");
    await activePage()
      .locator(MENU_ITEM("menu.ignored_with_parent"))
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await activePage().locator(MENU_ITEM("menu.unignore_path")).count(),
      0,
      "a file below a hidden folder cannot be shown alone",
    );
    screenshots.set("context-menu-below-hidden-folder.png", await activePage().screenshot());
    await activePage().keyboard.press("Escape");

    await openContextMenu("coble/drafts");
    await activePage().locator(MENU_ITEM("menu.unignore_path")).click();
    await waitForRulesFile("CONTRIBUTING.md\n");

    await toggleFiltersOff();
    await assertNotListed(["AGENTS.md", "scripts", "coble/CONTRIBUTING.md", "coble/references"]);
    await assertListed(["coble/drafts", "coble/drafts/old.md"]);
    await waitForApiFiles(["coble/drafts/old.md", "coble/notes.md", "index.md"]);
  });

  it("opens the same dialog from the application menu, and a removed rule lists the files again", async function () {
    await activePage().evaluate(() => {
      window.ipc.send("menu-provider", {
        command: "click-menu-item",
        payload: "menu.edit_ignore_rules",
      });
    });
    await activePage().locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    await activePage()
      .locator(`${DIALOG} [data-ignore-rules-global]`)
      .fill(GLOBAL_RULES.filter((rule) => rule !== "AGENTS.md").join("\n"));
    await activePage().locator(`${DIALOG} [data-ignore-rules-save]`).click();
    await activePage().locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });

    await assertListed(["AGENTS.md", "coble/AGENTS.md"]);
    await waitForApiFiles([
      "AGENTS.md",
      "coble/AGENTS.md",
      "coble/drafts/old.md",
      "coble/notes.md",
      "index.md",
    ]);
  });

  it("lists a file type once the window includes it, until a rule in the same window hides it", async function () {
    await writeFile(path.join(workspace, "coble", "proof.tex"), "\\section{Proof}\n", "utf8");
    await row("coble/notes.md").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await row("coble/proof.tex").count(), 0, "the default file types are Markdown");

    await openHeaderMenu();
    await activePage().locator(MENU_ITEM("explorer-edit-ignore-rules")).click();
    await activePage().locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    const include = activePage().locator(`${DIALOG} [data-ignore-rules-include]`);
    await include.fill(`${await include.inputValue()}\n.tex`);
    screenshots.set("file-filter-window.png", await activePage().screenshot());
    await activePage().locator(`${DIALOG} [data-ignore-rules-save]`).click();
    await activePage().locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });
    await assertListed(["coble/proof.tex"]);

    await openHeaderMenu();
    await activePage().locator(MENU_ITEM("explorer-edit-ignore-rules")).click();
    await activePage().locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    const globalRules = activePage().locator(`${DIALOG} [data-ignore-rules-global]`);
    await globalRules.fill(`${await globalRules.inputValue()}\n*.tex`);
    await activePage().locator(`${DIALOG} [data-ignore-rules-save]`).click();
    await activePage().locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });

    await assertNotListed(["coble/proof.tex"]);
    await assertListed(["coble/notes.md"]);
    screenshots.set("tex-hidden-by-rule.png", await activePage().screenshot());
  });

  it("keeps an open document open and saving after a rule hides it", async function () {
    const documentPath = path.join(workspace, "index.md");
    const tab = activePage().locator(
      `.document-tablist-wrapper [data-path=${JSON.stringify(documentPath)}]`,
    );
    await tab.waitFor({ state: "visible", timeout: 10_000 });

    await openContextMenu("index.md");
    await activePage().locator(MENU_ITEM("menu.ignore_path")).click();
    await waitForRulesFile("CONTRIBUTING.md\n/index.md\n");
    await assertNotListed(["index.md"]);
    await waitForApiFiles([
      "AGENTS.md",
      "coble/AGENTS.md",
      "coble/drafts/old.md",
      "coble/notes.md",
    ]);

    await tab.waitFor({ state: "visible", timeout: 10_000 });
    const editor = activePage().locator(".cm-content");
    await editor.click();
    await activePage().keyboard.press("ControlOrMeta+End");
    await activePage().keyboard.type("Hidden but open.");
    // The IPC call that the save-file shortcut makes: CDP key events do not
    // run the main-process menu accelerators.
    assert.deepEqual(
      await activePage().evaluate(
        async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
        documentPath,
      ),
      { ok: true },
    );
    assert.equal(await readFile(documentPath, "utf8"), "# Index\nHidden but open.");
    screenshots.set("hidden-document-open.png", await activePage().screenshot());
  });
});

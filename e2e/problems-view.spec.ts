import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditorView } from "@codemirror/view";
import type { Browser, Page } from "playwright";
import { assertCleanExit, attach, createFixture, findEditorPage, hideDevServerOverlay, preserveArtifacts, shutdown } from "./support/electron-app";

type EditorContent = HTMLElement & { cmTile?: { root: { view: EditorView } } };

describe("assembled app: Problems view", function () {
  this.timeout(180_000);
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let fixtureRoot: string;
  let fixPath: string;
  let secondWorkspace: string;
  let workspace: string;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-problems-e2e-", {
      documentName: "index.md",
      documentContents: "# Index\n",
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    await writeFile(path.join(workspace, "problem.md"), "Residue ???\n", "utf8");
    fixPath = path.join(workspace, "fix.md");
    await writeFile(fixPath, "Let $sin x = 0$.\n", "utf8");
    secondWorkspace = path.join(fixture.root, "second-workspace");
    await mkdir(secondWorkspace);
    await writeFile(path.join(secondWorkspace, "other.md"), "Another ???\n", "utf8");
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.app.openWorkspaces.push(secondWorkspace);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
    await preserveArtifacts(path.join(tmpdir(), "zettlr-problems-e2e-latest"), fixtureRoot, getOutput(), rendererEvents, screenshots);
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
    assertCleanExit(getOutput());
  });

  it("lists a background finding and selects its exact source range", async function () {
    await page.locator('[data-activity="problems"]').click();
    const finding = page.locator('.problems-finding').filter({ hasText: "document/authorial-residue" }).first();
    await finding.waitFor({ state: "visible", timeout: 90_000 });
    screenshots.set("problems-light.png", await page.screenshot());
    await finding.locator('.problems-jump').click();
    await page.waitForFunction(() => {
      const content = [...document.querySelectorAll<EditorContent>(".cm-content")].find((element) => element.cmTile?.root.view.state.doc.toString().includes("Residue ???"));
      return content?.cmTile?.root.view.state.selection.main.to !== content?.cmTile?.root.view.state.selection.main.from;
    });
    const selected = await page.evaluate(() => {
      const content = [...document.querySelectorAll<EditorContent>(".cm-content")].find((element) => element.cmTile?.root.view.state.doc.toString().includes("Residue ???"));
      if (content?.cmTile === undefined) throw new Error("The problem document did not open");
      const view = content.cmTile.root.view;
      const range = view.state.selection.main;
      return view.state.doc.sliceString(range.from, range.to);
    });
    assert.equal(selected, "???");
  });

  it("filters and groups findings, then applies a guarded machine fix", async function () {
    await page.locator('[data-activity="problems"]').click();
    await page.locator('[data-activity="problems"]').click();
    const fixFinding = page.locator('.problems-finding').filter({ hasText: "math/bare-operator" }).first();
    await fixFinding.waitFor({ state: "visible", timeout: 90_000 });
    await page.locator('[aria-label="Minimum severity"]').selectOption("warning");
    await page.locator('.problems-finding').filter({ hasText: "document/authorial-residue" }).waitFor({ state: "detached" });
    await page.locator('[aria-label="Minimum severity"]').selectOption("info");
    await page.locator('[aria-label="Group problems"]').selectOption("rule");
    await page.locator('.problems-group summary').filter({ hasText: "math/bare-operator" }).waitFor({ state: "visible" });
    const before = await page.evaluate(() => window.ipc.invoke("application", { command: "list-workspace-lint", payload: { scope: "all" } }));
    const record = before.documents.find((document: { path: string }) => document.path === fixPath);
    assert.ok(record, "The fixable document must be in the cache answer");
    const fix = record.diagnostics.find((diagnostic: { rule: string }) => diagnostic.rule === "math/bare-operator");
    assert.ok(fix?.fix, "Flowmark must provide the machine edit");
    await page.locator('.problems-group').filter({ hasText: "math/bare-operator" }).locator('.problems-fix').click();
    const expected = "Let $\\sin x = 0$.\n";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && await readFile(fixPath, "utf8") !== expected) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await readFile(fixPath, "utf8"), expected, await page.locator('#problems-view').innerText());
    const stale = await page.evaluate((request) => window.ipc.invoke("application", { command: "apply-lint-fix", payload: request }), {
      documentPath: fixPath,
      sourceHash: record.sourceHash,
      from: fix.from,
      to: fix.to,
      replacement: fix.fix.replacement,
    });
    assert.equal(stale.status, "conflict");
    assert.equal(await readFile(fixPath, "utf8"), expected);
  });

  it("switches between the active workspace and all loaded workspaces", async function () {
    await page.locator('[aria-label="Group problems"]').selectOption("document");
    await page.locator('[aria-label="Problem scope"]').selectOption("workspace");
    await page.locator('.problems-group').filter({ hasText: "other.md" }).waitFor({ state: "detached" });
    await page.locator('[aria-label="Problem scope"]').selectOption("all");
    await page.locator('.problems-group').filter({ hasText: "other.md" }).waitFor({ state: "visible", timeout: 90_000 });
    await page.locator('.problems-group').filter({ hasText: "fix.md" }).waitFor({ state: "detached", timeout: 90_000 });
    await page.evaluate(() => window.ipc.sendSync("config-provider", { command: "set-config-single", payload: { key: "darkMode", val: true } }));
    await page.locator("body.dark").waitFor({ state: "visible" });
    screenshots.set("problems-dark.png", await page.screenshot());
  });

  it("shows pending documents until the background queue fills their findings", async function () {
    await page.locator('[aria-label="Minimum severity"]').selectOption("error");
    await page.getByText("No problems", { exact: true }).waitFor({ state: "visible" });
    screenshots.set("problems-empty.png", await page.screenshot());
    await page.locator('[aria-label="Minimum severity"]').selectOption("info");
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      writeFile(path.join(workspace, `late-${String(index).padStart(3, "0")}.md`),
        index === 79 ? "Late ???\n" : `# Clean ${index}\n`, "utf8")));
    const pending = page.locator('[data-problems-pending]');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && await pending.count() === 0) {
      await page.getByRole("button", { name: "Refresh problems" }).click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await pending.waitFor({ state: "visible" });
    screenshots.set("problems-pending.png", await page.screenshot());
    await pending.waitFor({ state: "detached", timeout: 90_000 });
    await page.locator('.problems-group').filter({ hasText: "late-079.md" }).waitFor({ state: "visible", timeout: 90_000 });
  });
});

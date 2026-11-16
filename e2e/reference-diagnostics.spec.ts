/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: the diagnostics of labels and references in the window
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: A label that two documents define, a reference whose label no
 *              document defines, and a rename onto a label that exists are
 *              the three faults of the workspace references. The first two
 *              are findings of the lint: the Problems view lists them under
 *              each document, and the editor draws no chip for a reference
 *              that has no one definition. The third is refused with its
 *              cause and renames nothing (#47, row 47.4.c).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditorView } from "@codemirror/view";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-reference-diagnostics-e2e-latest");

/** The open document: one label that another file defines too, and three references. */
const INTRO = [
  "# Intro {#sec:intro}",
  "",
  "## Method {#sec:method}",
  "",
  "See @sec:missing, @sec:methods and @sec:intro.",
  "",
].join("\n");
/** The line of the label `sec:method` in the open document, from 1. */
const METHOD_LINE = 3;
const DUPLICATE = "# Also an intro {#sec:intro}\n";
const METHODS = "# Methods {#sec:methods}\n";

const OFFER = '.application-menu .menu-item[data-id="apply-workspace-rename"]';
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

describe("assembled app: the diagnostics of labels and references (#47)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let introPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** The text of the editor. */
  async function editorText(activePage: Page): Promise<string> {
    return await activePage.evaluate(() => {
      const view = document.querySelector<EditorContentElement>(".cm-content")?.cmTile?.root.view;
      if (view === undefined) {
        throw new Error("the production editor exposes no CodeMirror view");
      }
      return view.state.doc.toString();
    });
  }

  /** The findings that the Problems view lists under one document, once one has a part. */
  async function findingsOf(activePage: Page, documentName: string, part: string) {
    // The group of a document has its name in its summary; the text of a
    // finding can name another document.
    const findings = activePage
      .locator(".problems-group")
      .filter({ has: activePage.locator("summary", { hasText: documentName }) })
      .locator(".problems-finding");
    await findings.filter({ hasText: part }).first().waitFor({ state: "visible", timeout: 90_000 });
    return await findings.evaluateAll((rows) =>
      rows.map((row) => ({
        severity: row.getAttribute("data-severity"),
        text: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
    );
  }

  before(async function () {
    const fixture = await createFixture("zettlr-reference-diagnostics-e2e-", {
      documentName: "intro.md",
      documentContents: INTRO,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    introPath = fixture.documentPath;
    const workspace = path.dirname(introPath);
    await writeFile(path.join(workspace, "duplicate.md"), DUPLICATE, "utf8");
    await writeFile(path.join(workspace, "methods.md"), METHODS, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents);
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

  it("draws a chip for a reference with one definition, and none for a missing or a duplicate label", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The caret is on the first line; the references are on another line.
    const chips = activePage.locator(".reference-chip");
    await chips.first().waitFor({ state: "visible", timeout: 30_000 });

    const line = activePage.locator(".cm-line", { hasText: "See " });
    assert.equal(await line.locator(".reference-chip").count(), 1, "one reference resolves");
    const text = await line.innerText();
    assert.ok(text.includes("@sec:missing"), `the missing reference stays as its source: ${text}`);
    assert.ok(text.includes("@sec:intro"), `the duplicate reference stays as its source: ${text}`);
    assert.ok(!text.includes("@sec:methods"), `the resolved reference is a chip: ${text}`);
    screenshots.set("chips.png", await activePage.screenshot());
  });

  it("lists the label of two documents as an error under each of them, and the missing label as a warning", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.locator('[data-activity="problems"]').click();

    const intro = await findingsOf(activePage, "intro.md", "defined more than once");
    screenshots.set("problems.png", await activePage.screenshot());
    const duplicateOfIntro = intro.find((row) => row.text.includes("defined more than once"));
    assert.ok(duplicateOfIntro !== undefined);
    assert.equal(duplicateOfIntro.severity, "error");
    assert.ok(
      duplicateOfIntro.text.includes("`#sec:intro` is defined more than once") &&
        duplicateOfIntro.text.includes("reference/duplicate-workspace-definition"),
      `the finding names the label and its rule: ${duplicateOfIntro.text}`,
    );
    const missing = intro.find((row) => row.text.includes("Undefined reference"));
    assert.ok(missing !== undefined, `the missing label is a finding: ${JSON.stringify(intro)}`);
    assert.equal(missing.severity, "warning");
    assert.ok(
      missing.text.includes("Undefined reference `@sec:missing`.") &&
        missing.text.includes("reference/missing-workspace-definition"),
      `the finding names the reference and its rule: ${missing.text}`,
    );

    // The other document that defines the label has the same error.
    const duplicate = await findingsOf(activePage, "duplicate.md", "defined more than once");
    assert.deepEqual(
      duplicate.map((row) => row.severity),
      ["error"],
      "the second definition is the one finding of its document",
    );
  });

  it("refuses a rename onto a label that another document defines, and renames nothing", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    // The author types "s" at the end of the key `sec:method`: the key
    // `sec:methods` is the label of methods.md.
    await activePage.locator(".cm-content").click();
    await activePage.keyboard.press("Control+Home");
    for (let step = 1; step < METHOD_LINE; step++) {
      await activePage.keyboard.press("ArrowDown");
    }
    await activePage.keyboard.press("End");
    await activePage.keyboard.press("ArrowLeft");
    await activePage.keyboard.type("s");
    await activePage.keyboard.press("ArrowDown");

    const offer = activePage.locator(OFFER);
    await offer.waitFor({ state: "visible", timeout: 30_000 });
    await offer.click();

    const toast = activePage.locator(ERROR_TOAST).first();
    await toast.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("rename-collision.png", await activePage.screenshot());
    assert.equal(
      (await toast.innerText()).trim().split("\n")[0],
      `Cannot rename: sec:methods is already defined in ${path.join(path.dirname(introPath), "methods.md")}.`,
    );
    // The refusal renames nothing. The key that the author typed stays in
    // the editor, as it does when the author declines the offer, and no
    // file changed.
    const typed = INTRO.replace("{#sec:method}", "{#sec:methods}");
    const deadline = Date.now() + 10_000;
    while ((await editorText(activePage)) !== typed && Date.now() < deadline) {
      await delay(100);
    }
    assert.equal(await editorText(activePage), typed);
    assert.equal(await readFile(introPath, "utf8"), INTRO);
    assert.equal(
      await readFile(path.join(path.dirname(introPath), "methods.md"), "utf8"),
      METHODS,
      "the document of the other definition is unchanged",
    );

    // The author saves the document, so the app quits without a prompt.
    // This is the IPC call that the save-file shortcut makes: CDP key
    // events do not reach the shortcut.
    await activePage.evaluate(
      async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
      introPath,
    );
  });
});

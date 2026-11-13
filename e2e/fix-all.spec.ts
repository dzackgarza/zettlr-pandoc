/**
 * Assembled-app proof of Fix All: the Format menu's three commands ask
 * Flowmark for the machine-applicable fixes of a scope, show how many fixes
 * change how many documents, and apply exactly those fixes on confirmation.
 * A suggestion that needs the author's choice is never applied.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type EditorView } from "@codemirror/view";
import { type Browser, type Locator, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";
import { leafIds, openInLeaf } from "./support/panes";

const INDEX = "Let $sin x = 0$.\n";
const OTHER = "Then $cos y + sin z = 1$.\n";
const CLEAN = "# Clean\n\nNothing to fix.\n";

const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const INFO_TOAST = "#zettlr-toast-container .zettlr-toast.info";
const DIALOG = "[data-fix-all-dialog]";
const SUMMARY = `${DIALOG} [data-fix-all-summary]`;

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } };

async function editorText(page: Page): Promise<string> {
  return await page
    .locator(".cm-content")
    .filter({ visible: true })
    .evaluate((content) => {
      const view = (content as EditorContentElement).cmTile?.root.view;
      if (view === undefined) {
        throw new Error("The visible .cm-content has no CodeMirror view");
      }
      return view.state.doc.toString();
    });
}

/** The text of an element. Playwright returns null only for a document or doctype node. */
async function elementText(locator: Locator): Promise<string> {
  const text = await locator.textContent();
  if (text === null) {
    throw new Error("The locator matched a node that is not an element");
  }
  return text;
}

async function clickMenuItem(page: Page, id: string): Promise<void> {
  await page.evaluate((itemId) => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: itemId });
  }, id);
}

/** The summary once the plan has arrived. */
async function plannedSummary(page: Page): Promise<string> {
  const summary = page.locator(SUMMARY);
  await summary.waitFor({ state: "visible", timeout: 60_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const text = await elementText(summary);
    if (!text.startsWith("Finding fixes")) {
      return text;
    }
    await delay(150);
  }
  throw new Error("Fix All never received its plan");
}

async function waitForFile(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await readFile(filePath, "utf8")) === expected) {
      return;
    }
    await delay(150);
  }
  assert.equal(await readFile(filePath, "utf8"), expected);
}

describe("assembled app: Fix All applies the machine-applicable fixes", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let indexPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-fix-all-e2e-", {
      documentName: "index.md",
      documentContents: INDEX,
      // Dark mode: the platform rules for a control weigh the most there.
      config: { darkMode: true },
    });
    fixtureRoot = fixture.root;
    indexPath = fixture.documentPath;
    workspace = path.dirname(indexPath);
    await writeFile(path.join(workspace, "other.md"), OTHER, "utf8");
    await writeFile(path.join(workspace, "clean.md"), CLEAN, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    if (page !== undefined) {
      screenshots.set("fix-all.png", await page.screenshot());
    }
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-fix-all-e2e-latest"),
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

  it("fixes the focused document after the user confirms the count", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    await clickMenuItem(page, "menu.fix_all_document");
    assert.equal(
      await plannedSummary(page),
      "Apply 1 fix to 1 of 1 document? Every fix keeps the meaning of the text.",
    );
    assert.match(
      await elementText(page.locator(`${DIALOG} [data-fix-all-rules]`)),
      /math\/bare-operator\s*1/,
    );
    screenshots.set("fix-all-document.png", await page.screenshot());
    const painted = await page.evaluate((dialogSelector) => {
      const confirm = document.querySelector(`${dialogSelector} [data-fix-all-confirm]`);
      const cancel = document.querySelector(`${dialogSelector} button:not([data-fix-all-confirm])`);
      const dialog = document.querySelector(dialogSelector);
      if (dialog == null || confirm == null || cancel == null) {
        throw new Error("The Fix All confirmation has no two actions");
      }
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.backgroundColor = "var(--chrome-row-accent)";
      const accent = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "var(--chrome-surface)";
      const surface = getComputedStyle(probe).backgroundColor;
      probe.style.color = "var(--chrome-text)";
      const chromeText = getComputedStyle(probe).color;
      probe.remove();
      return {
        text: getComputedStyle(dialog).color,
        chromeText,
        confirm: getComputedStyle(confirm).backgroundColor,
        cancel: getComputedStyle(cancel).backgroundColor,
        accent,
        surface,
      };
    }, DIALOG);
    assert.equal(
      painted.confirm,
      painted.accent,
      "the action that fixes has the accent colour of the window",
    );
    assert.equal(
      painted.cancel,
      painted.surface,
      "the action that cancels has the surface colour of the window",
    );
    assert.equal(
      painted.text,
      painted.chromeText,
      "the confirmation has the text colour of the window chrome",
    );

    await page.locator(`${DIALOG} [data-fix-all-confirm]`).click();
    await page.locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });
    await waitForFile(indexPath, "Let $\\sin x = 0$.\n");
    assert.equal(await editorText(page), "Let $\\sin x = 0$.\n");
    assert.equal(
      await readFile(path.join(workspace, "other.md"), "utf8"),
      OTHER,
      "the document scope leaves other documents alone",
    );
  });

  it("summarises the workspace per rule and per document, then fixes the closed files", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    await clickMenuItem(page, "menu.fix_all_workspace");
    assert.equal(
      await plannedSummary(page),
      "Apply 2 fixes to 1 of 3 documents? Every fix keeps the meaning of the text.",
    );
    assert.match(
      await elementText(page.locator(`${DIALOG} [data-fix-all-documents]`)),
      /other\.md\s*2/,
    );
    screenshots.set("fix-all-workspace.png", await page.screenshot());

    await page.locator(`${DIALOG} [data-fix-all-confirm]`).click();
    await waitForFile(path.join(workspace, "other.md"), "Then $\\cos y + \\sin z = 1$.\n");
    assert.equal(await readFile(path.join(workspace, "clean.md"), "utf8"), CLEAN);
  });

  it("reports that nothing is left to fix", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    await clickMenuItem(page, "menu.fix_all_open");
    assert.equal(await plannedSummary(page), "No auto-fixable issues in 1 document.");
    assert.equal(await page.locator(`${DIALOG} [data-fix-all-confirm]`).count(), 0);
    await page.keyboard.press("Escape");
  });

  it("keeps the fixes of a document whose file refuses the save, offers a copy and saves the other documents", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    await writeFile(indexPath, INDEX, "utf8");
    // A second open document whose file takes the save.
    const zetaPath = path.join(workspace, "zeta.md");
    await writeFile(zetaPath, OTHER, "utf8");
    const [leaf] = await leafIds(editorPage);
    assert.ok(leaf !== undefined, "the window has a pane");
    await openInLeaf(editorPage, leaf, zetaPath);
    await editorPage
      .locator(`.document-tablist-wrapper [data-path=${JSON.stringify(indexPath)}]`)
      .click();
    const deadline = Date.now() + 20_000;
    while ((await editorText(editorPage)) !== INDEX) {
      assert.ok(Date.now() < deadline, "the editor loads the text of the file");
      await delay(150);
    }
    await chmod(indexPath, 0o400);
    await editorPage.evaluate(() => {
      for (const toast of document.querySelectorAll("#zettlr-toast-container .zettlr-toast")) {
        toast.remove();
      }
    });

    await clickMenuItem(editorPage, "menu.fix_all_open");
    assert.equal(
      await plannedSummary(editorPage),
      "Apply 3 fixes to 2 of 2 documents? Every fix keeps the meaning of the text.",
    );
    await editorPage.locator(`${DIALOG} [data-fix-all-confirm]`).click();

    const refusal = editorPage.locator(ERROR_TOAST);
    await refusal.first().waitFor({ state: "visible", timeout: 30_000 });
    // The other messages of the same commit arrive in the same task.
    await delay(1_000);
    screenshots.set("fix-all-save-refused.png", await editorPage.screenshot());
    const refusals = await refusal.count();
    const message = await refusal.first().locator("span:first-child").innerText();
    const actions = await refusal.first().locator("[data-toast-action]").allInnerTexts();
    const applied = await editorPage.locator(INFO_TOAST).allInnerTexts();
    const shown = await editorText(editorPage);
    const onDisk = await readFile(indexPath, "utf8");
    const zetaOnDisk = await readFile(zetaPath, "utf8");

    // The file takes the save again, and the document with the fix saves,
    // so the app quits without a prompt. This is the IPC call that the
    // save-file shortcut makes: CDP key events do not reach the shortcut.
    await chmod(indexPath, 0o600);
    await editorPage.evaluate(
      async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
      indexPath,
    );
    await waitForFile(indexPath, "Let $\\sin x = 0$.\n");

    assert.equal(refusals, 1, "one refused save shows one message");
    assert.ok(message.includes("index.md"), `the message names the file: ${message}`);
    assert.deepEqual(actions, ["Save a copy…"], "the message offers a copy of the text");
    assert.ok(
      applied.some((text) => text.startsWith("Applied 3 fixes to 2 documents")),
      `the window says that the fix is applied: ${applied.join(" | ")}`,
    );
    assert.equal(shown, "Let $\\sin x = 0$.\n", "the editor has the fix");
    assert.equal(onDisk, INDEX, "the refused save leaves the text of the file");
    assert.equal(
      zetaOnDisk,
      "Then $\\cos y + \\sin z = 1$.\n",
      "the refused save of one document does not stop the save of the other",
    );
  });
});

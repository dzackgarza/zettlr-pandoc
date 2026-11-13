/**
 * Assembled-app proof that a reference rename shows its edits before it
 * changes a document (#6).
 *
 * The author types a new key into the id of a heading and moves the caret
 * off it. The editor offers the rename across the workspace; when the author
 * takes the offer, the window shows the shared preview of a workspace edit:
 * each document that the rename changes, with each changed line before and
 * after, and the old and the new key. No document changes until the author
 * applies. Cancel gives the author back the key that they typed and changes
 * no other document. Apply rewrites each use: a closed document on disk, the
 * open document in its buffer (unsaved), with Undo in the message.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
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
import { PREVIEW, previewRows, textOnceItIs } from "./support/workspace-edit-preview";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-reference-rename-preview-e2e-latest");
const OFFER = '.application-menu .menu-item[data-id="apply-workspace-rename"]';

const DEFINITIONS = "# Intro {#sec:intro}\n\n# Method {#sec:method}\n\nText.\n";
const USES = "See @sec:intro and @sec:method for details.\n";

/** The text of the active editor. */
async function editorText(page: Page): Promise<string> {
  return await page.locator(".cm-content").evaluate((content) => {
    const text = (
      content as HTMLElement & {
        cmTile?: { root?: { view?: { state?: { doc?: { toString(): string } } } } };
      }
    ).cmTile?.root?.view?.state?.doc?.toString();
    if (text === undefined) {
      throw new Error("Could not read the active CodeMirror document state");
    }
    return text;
  });
}

/** The text of the active editor once it is `expected`, or its text after ten seconds. */
async function editorTextOnceItIs(page: Page, expected: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await editorText(page);
  while (Date.now() < deadline && text !== expected) {
    await delay(100);
    text = await editorText(page);
  }
  return text;
}

/**
 * Types `suffix` at the end of the key of the id on `line` (from 1) and moves
 * the caret to the next line, as an author does; the editor then offers the
 * rename.
 */
async function extendKeyOnLine(page: Page, line: number, suffix: string): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  for (let step = 1; step < line; step++) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(suffix);
  await page.keyboard.press("ArrowDown");
}

describe("assembled app: a reference rename shows its edits before it changes a document (#6)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let definitionsPath = "";
  let usesPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-reference-rename-preview-e2e-", {
      documentName: "a.md",
      documentContents: DEFINITIONS,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    definitionsPath = fixture.documentPath;
    usesPath = path.join(path.dirname(definitionsPath), "b.md");
    await writeFile(usesPath, USES, "utf8");

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

  it("previews each use and gives the author back the typed key on Cancel", async function () {
    const activePage = requireInitialized(page, "The editor window must be open");
    await extendKeyOnLine(activePage, 1, "duction");
    const offer = activePage.locator(OFFER);
    await offer.waitFor({ state: "visible", timeout: 30_000 });
    await offer.click();

    const preview = activePage.locator(PREVIEW);
    await preview.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("reference-rename-preview-light.png", await activePage.screenshot());
    assert.equal(await preview.locator("[data-rename-old-key]").innerText(), "sec:intro");
    assert.equal(await preview.locator("[data-rename-new-key]").innerText(), "sec:introduction");
    assert.deepEqual(await previewRows(activePage), [
      {
        documentPath: definitionsPath,
        changes: [{ before: "# Intro {#sec:intro}", after: "# Intro {#sec:introduction}" }],
      },
      {
        documentPath: usesPath,
        changes: [
          {
            before: USES.trimEnd(),
            after: "See @sec:introduction and @sec:method for details.",
          },
        ],
      },
    ]);

    // The preview stays until the author decides; nothing changed yet.
    await delay(1000);
    assert.equal(await readFile(usesPath, "utf8"), USES);

    await preview.locator("[data-cancel]").click();
    await preview.waitFor({ state: "detached", timeout: 30_000 });
    const typed = DEFINITIONS.replace("{#sec:intro}", "{#sec:introduction}");
    assert.equal(await editorTextOnceItIs(activePage, typed), typed);
    await delay(1000);
    assert.equal(await readFile(usesPath, "utf8"), USES);
    assert.equal(await readFile(definitionsPath, "utf8"), DEFINITIONS);
  });

  it("rewrites each use when the author applies, and offers Undo", async function () {
    const activePage = requireInitialized(page, "The editor window must be open");
    await activePage.evaluate(() => document.body.classList.add("dark"));
    await extendKeyOnLine(activePage, 3, "s");
    const offer = activePage.locator(OFFER);
    await offer.waitFor({ state: "visible", timeout: 30_000 });
    await offer.click();

    const preview = activePage.locator(PREVIEW);
    await preview.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("reference-rename-preview-dark.png", await activePage.screenshot());
    await activePage.evaluate(() => document.body.classList.remove("dark"));
    assert.deepEqual(
      (await previewRows(activePage)).map((row) => row.documentPath),
      [definitionsPath, usesPath],
    );

    await preview.locator("[data-apply]").click();
    await preview.waitFor({ state: "detached", timeout: 30_000 });

    const uses = "See @sec:intro and @sec:methods for details.\n";
    assert.equal(await textOnceItIs(usesPath, uses), uses);
    const buffer = DEFINITIONS.replace("{#sec:intro}", "{#sec:introduction}").replace(
      "{#sec:method}",
      "{#sec:methods}",
    );
    assert.equal(await editorTextOnceItIs(activePage, buffer), buffer);
    // The open document takes the rename in its buffer; the author saves it.
    assert.equal(await readFile(definitionsPath, "utf8"), DEFINITIONS);
    const undo = activePage
      .locator("#zettlr-toast-container .zettlr-toast")
      .filter({ hasText: "sec:methods" })
      .locator("[data-toast-action]");
    await undo.first().waitFor({ state: "visible", timeout: 10_000 });
    assert.deepEqual(await undo.allInnerTexts(), ["Undo"]);

    // The author saves the renamed buffer, so the app quits without a
    // prompt. This is the IPC call that the save-file shortcut makes: CDP
    // key events do not reach the shortcut.
    await activePage.evaluate(
      async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
      definitionsPath,
    );
    assert.equal(await textOnceItIs(definitionsPath, buffer), buffer);
  });
});

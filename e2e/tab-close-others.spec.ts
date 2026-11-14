/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        "Close other tabs" of the tab context menu E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Close other tabs" closes the tabs of the pane one after
 *                  the other, as "Close all tabs" does (#202): it asks about
 *                  one document with unsaved text at a time, and a pinned
 *                  tab stays open without a question.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { nativeDialog, nativeDialogs, pressKey, windowOfPage } from "./support/native-dialog";
import { leafIds, openInLeaf } from "./support/panes";

const SAVE_PROMPT = "Unsaved changes";

/** The paths of the tabs of every pane of the window. */
async function openTabs(page: Page): Promise<string[]> {
  return await page.locator('[role="tab"][data-path]').evaluateAll((tabs) =>
    tabs.map((tab) => {
      const tabPath = tab.getAttribute("data-path");
      if (tabPath === null) {
        throw new Error("A tab of the selector [data-path] has no data-path.");
      }
      return tabPath;
    }),
  );
}

function tab(page: Page, documentPath: string) {
  return page.locator(`[role="tab"][data-path=${JSON.stringify(documentPath)}]`);
}

/** Activates the tab of a document and types text at the end of its editor. */
async function typeInto(page: Page, documentPath: string, text: string): Promise<void> {
  await tab(page, documentPath).click();
  await tab(page, documentPath).and(page.locator(".active")).waitFor();
  await page.locator(".main-editor-wrapper .cm-content:visible").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
  await tab(page, documentPath).and(page.locator(".modified")).waitFor();
}

describe("Close other tabs from the context menu of a tab (#202)", function () {
  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let genus = "";
  let lemma = "";
  let form = "";

  before(async function () {
    assert.equal(process.env.DISPLAY !== undefined, true, "the run has a display");
    const fixture = await createFixture("zettlr-tab-close-others-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
    });
    genus = fixture.documentPath;
    lemma = path.join(path.dirname(genus), "lemma.md");
    form = path.join(path.dirname(genus), "form.md");
    await writeFile(lemma, "# Lemma\n\nA unimodular lattice is its own dual.\n");
    await writeFile(form, "# Form\n\nThe discriminant form of an even lattice.\n");
    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, []));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  it("asks about one document at a time and keeps a pinned tab", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const [leaf] = await leafIds(activePage);
    for (const documentPath of [genus, lemma, form]) {
      await openInLeaf(activePage, leaf, documentPath);
    }
    await activePage.evaluate(
      async ([leafId, pinnedPath]) => {
        const windowId = new URLSearchParams(location.search).get("window_id");
        if (windowId === null) {
          throw new Error("The main window carries no window_id");
        }
        await window.ipc.invoke("documents-provider", {
          command: "set-pinned",
          payload: { windowId, leafId, path: pinnedPath, pinned: true },
        });
      },
      [leaf, form],
    );
    await typeInto(activePage, lemma, " Its discriminant is one.");
    await typeInto(activePage, form, " It is a finite quadratic form.");

    await tab(activePage, genus).click({ button: "right" });
    await activePage
      .locator(".application-menu .menu-item", { hasText: "Close other tabs" })
      .last()
      .click();

    // One question, about the document of the tab that is not pinned; the
    // default answer saves it.
    const prompt = await nativeDialog(SAVE_PROMPT, 30_000);
    await pressKey(prompt, "Return");
    const later = await nativeDialogs(SAVE_PROMPT, 3_000);
    assert.deepEqual(later, [], "no second question");

    const deadline = Date.now() + 10_000;
    while ((await openTabs(activePage)).length > 2 && Date.now() < deadline) {
      await delay(100);
    }
    assert.deepEqual(
      {
        tabs: (await openTabs(activePage)).sort(),
        lemmaSaved: (await readFile(lemma, "utf8")).includes("Its discriminant is one."),
        formUnsaved: await tab(activePage, form).evaluate((element) =>
          element.classList.contains("modified"),
        ),
      },
      { tabs: [form, genus].sort(), lemmaSaved: true, formUnsaved: true },
    );

    // The pinned document keeps its text: a save writes it.
    await tab(activePage, form).click();
    await activePage.locator(".main-editor-wrapper .cm-content:visible").click();
    await pressKey(await windowOfPage(activePage), "ctrl+s");
    const saved = Date.now() + 10_000;
    let text = await readFile(form, "utf8");
    while (!text.includes("It is a finite quadratic form.") && Date.now() < saved) {
      await delay(100);
      text = await readFile(form, "utf8");
    }
    assert.ok(text.includes("It is a finite quadratic form."), "the pinned document saves");
  });
});

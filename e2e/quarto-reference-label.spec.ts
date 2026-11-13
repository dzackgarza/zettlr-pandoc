/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference labels in a Quarto book E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A chapter of a Quarto book has a figure and a theorem.
 *                  The author opens the context menu of each and chooses
 *                  "Create reference label…". Quarto numbers a figure whose
 *                  id has a hyphen (`#fig-key`); the theorem filters of the
 *                  book (custom-numbered-blocks, the amsthm filters of
 *                  ~/.pandoc) number a theorem whose id has a colon
 *                  (`#thm:key`). The dialog shows that key and inserts it
 *                  (#204).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-quarto-reference-label-e2e-latest");
const DOCUMENT = [
  "# Orbits",
  "",
  "The orbit of a point.",
  "",
  '::: {.theorem title="Closed orbits"}',
  "Each orbit is closed.",
  ":::",
  "",
].join("\n");
const MANIFEST = "project:\n  type: book\nbook:\n  title: Orbits\n  chapters:\n    - orbits.md\n";

/** The text of the document at the path, as the documents provider holds it. */
async function documentText(page: Page, documentPath: string): Promise<string> {
  return await page.evaluate(async (target) => {
    return (await window.ipc.invoke("application", {
      command: "get-document-text",
      payload: target,
    })) as string;
  }, documentPath);
}

/**
 * Saves the document, so the app quits without a prompt. This is the IPC
 * call of the save shortcut: CDP key events do not reach the shortcut.
 */
async function saveDocument(page: Page, documentPath: string): Promise<void> {
  await page.evaluate(
    async (target) => await window.ipc.invoke("documents:save-file", { path: target }),
    documentPath,
  );
}

/**
 * Opens the context menu on the target, chooses "Create reference label…"
 * and confirms the proposed slug. Answers the key prefix that the dialog
 * showed and the slug it proposed.
 */
async function createLabel(page: Page, target: Locator): Promise<{ prefix: string; slug: string }> {
  await target.click({ button: "right" });
  await page
    .locator(".application-menu .menu-item")
    .filter({ has: page.locator(".label", { hasText: /^Create reference label…$/ }) })
    .click();
  const dialog = page.locator(".create-reference-label-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const prefix = await dialog.locator("[data-family-prefix]").innerText();
  const input = dialog.locator("input");
  const slug = await input.inputValue();
  await input.press("Enter");
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  return { prefix, slug };
}

describe("assembled app: reference labels in a Quarto book", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-quarto-reference-label-e2e-", {
      documentName: "orbits.md",
      documentContents: DOCUMENT,
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    const workspace = path.dirname(fixture.documentPath);
    await writeFile(path.join(workspace, "_quarto.yml"), MANIFEST, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: 1400, height: 900 });
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

  it("labels a section with the id that Quarto numbers", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const target = requireInitialized(documentPath, "The document path must be initialized");
    const heading = shown
      .locator(".cm-line", { hasText: /Orbits$/ })
      .first()
      .getByText("Orbits", { exact: true });
    await heading.waitFor({ state: "visible", timeout: 20_000 });

    const { prefix, slug } = await createLabel(shown, heading);
    screenshots.set("section-labelled.png", await shown.screenshot());
    const text = await documentText(shown, target);
    await saveDocument(shown, target);

    assert.equal(prefix, "sec-", "the dialog shows the Quarto section prefix");
    assert.ok(text.startsWith(`# Orbits {#sec-${slug}}\n`), "the heading carries the Quarto id");
  });

  it("labels a theorem with the id that the theorem filters number", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const target = requireInitialized(documentPath, "The document path must be initialized");
    const statement = shown.locator(".cm-line", { hasText: /^Each orbit is closed\.$/ });
    await statement.waitFor({ state: "visible", timeout: 20_000 });

    const { prefix, slug } = await createLabel(shown, statement);
    screenshots.set("theorem-labelled.png", await shown.screenshot());
    const text = await documentText(shown, target);
    await saveDocument(shown, target);

    assert.equal(prefix, "thm:", "the dialog shows the theorem prefix");
    assert.ok(
      text.includes(`::: {.theorem title="Closed orbits" #thm:${slug}}`),
      "the theorem carries the colon id",
    );
  });
});

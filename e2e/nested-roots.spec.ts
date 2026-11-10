/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Nested roots E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens the assembled app on a Quarto book that holds a
 *                  second Quarto book in a subdirectory, with a file beside
 *                  the workspace whose path starts with the workspace path.
 *                  Reads which book the Book section and the Explorer give
 *                  each document.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConfigOptions } from "@providers/config/get-config-template";
import type { Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createWorkspaceFixture,
  delay,
  type Fixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  REPO_ROOT,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-nested-roots-e2e-latest");
const BOOK_SECTION = '#navigation-sidebar [data-section="book"]';
const CHAPTER_LABEL = `${BOOK_SECTION} .quarto-book-outline button.chapter .chrome-row-label`;

async function waitUntil(probe: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Opens a document as the user does from the launcher, and waits for its text. */
async function openDocument(page: Page, documentPath: string, text: string): Promise<void> {
  await page.evaluate(
    async (pathInPage) =>
      await window.ipc.invoke("documents-provider", {
        command: "open-file",
        payload: { path: pathInPage, newTab: true },
      }),
    documentPath,
  );
  await page.locator(".cm-content", { hasText: text }).waitFor({ timeout: 20_000 });
}

/** The chapter titles of the Book section, in the order shown. */
async function bookChapters(page: Page): Promise<string[]> {
  if ((await page.locator(BOOK_SECTION).count()) === 0) {
    return [];
  }
  if ((await page.locator(`${BOOK_SECTION}[data-state="open"]`).count()) === 0) {
    await page.locator(`${BOOK_SECTION} .chrome-section-trigger`).click();
  }
  return (await page.locator(CHAPTER_LABEL).allTextContents()).map((label) => label.trim());
}

describe("a book inside a book, and a file beside the workspace", function () {
  let fixture: Fixture | undefined;
  let app: Awaited<ReturnType<typeof attach>> | undefined;
  let page: Page | undefined;
  let outerChapters: string[] = [];
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  const workspace = (): string =>
    path.join(requireInitialized(fixture, "fixture").root, "workspace");
  const tables = (): string => path.join(workspace(), "appendix", "tables.md");
  // The path of this file starts with the path of the workspace, and the
  // file is outside the workspace.
  const beside = (): string =>
    path.join(requireInitialized(fixture, "fixture").root, "workspace-notes.md");

  before(async function () {
    fixture = await createWorkspaceFixture("zettlr-nested-roots-e2e-", {
      workspaceSource: path.join(REPO_ROOT, "test", "fixtures", "quarto-book"),
      activeDocument: path.join("computation", "sage.md"),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true },
      },
    });
    const appendix = path.dirname(tables());
    await mkdir(appendix);
    await writeFile(
      path.join(appendix, "_quarto.yml"),
      [
        "project:",
        "  type: book",
        "book:",
        "  title: Appendix",
        "  chapters:",
        "    - proofs.md",
        "    - tables.md",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(appendix, "proofs.md"), "# Appendix proofs\n\nThe long proofs.\n");
    await writeFile(tables(), "# Appendix tables\n\nThe long tables.\n");
    await writeFile(beside(), "# Notes beside the book\n\nNo chapter.\n");

    app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.locator(".cm-content", { hasText: "Sage" }).waitFor({ timeout: this.timeout() });
    await page.locator(BOOK_SECTION).waitFor({ state: "visible", timeout: 20_000 });
    outerChapters = await bookChapters(page);
  });

  after(async function () {
    await shutdown(app?.browser, app?.appProcess);
    const output = app === undefined ? "" : app.getOutput();
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixture?.root, output, rendererEvents, screenshots);
    if (fixture !== undefined) {
      await rm(fixture.root, { recursive: true, force: true });
    }
    assertCleanExit(output);
  });

  it("shows the workspace book for a chapter of the workspace book", function () {
    assert.equal(outerChapters.length, 4);
    assert.equal(outerChapters[3], "Sage");
  });

  it("shows the inner book in the Book section for a chapter of the inner book", async function () {
    const activePage = requireInitialized(page, "editor page");
    await openDocument(activePage, tables(), "The long tables.");
    await waitUntil(
      async () => (await bookChapters(activePage)).join("|") !== outerChapters.join("|"),
      "the Book section to leave the workspace book for a chapter of the appendix",
    );
    screenshots.set("appendix-chapter.png", await activePage.screenshot());
    assert.deepEqual(await bookChapters(activePage), ["Appendix proofs", "Appendix tables"]);
  });

  it("marks a chapter of the inner book in the Explorer by its place in the inner book", async function () {
    const activePage = requireInitialized(page, "editor page");
    await openDocument(activePage, tables(), "The long tables.");
    const membership = activePage.locator(
      `.tree-item[data-path=${JSON.stringify(tables())}] .project-membership`,
    );
    await membership.waitFor({ state: "visible", timeout: 20_000 });
    await waitUntil(
      async () => (await membership.locator(".membership-position").count()) === 1,
      "the Explorer to give the appendix chapter a place in a book",
    );
    assert.deepEqual(
      {
        classes: ((await membership.getAttribute("class")) ?? "").split(/\s+/).sort(),
        position: await membership.locator(".membership-position").allTextContents(),
      },
      { classes: ["included", "project-membership", "quarto"], position: ["2"] },
    );
  });

  it("keeps a file beside the workspace out of the book, as a root file", async function () {
    const activePage = requireInitialized(page, "editor page");
    await openDocument(activePage, beside(), "No chapter.");
    await waitUntil(
      async () => (await activePage.locator(BOOK_SECTION).count()) === 0,
      "the Book section to go away for a file beside the workspace",
    );
    screenshots.set("file-beside-workspace.png", await activePage.screenshot());
    const roots = await activePage.evaluate(() => {
      const { app: appConfig } = window.ipc.sendSync<ConfigOptions>("config-provider", {
        command: "get-config",
      });
      return { openFiles: appConfig.openFiles, openWorkspaces: appConfig.openWorkspaces };
    });
    assert.deepEqual(roots, { openFiles: [beside()], openWorkspaces: [workspace()] });
  });
});

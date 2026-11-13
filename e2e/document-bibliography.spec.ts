/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The bibliography of a document in each view that renders it
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A document has one bibliography: the files that its front
 *                  matter names, relative to its folder, else the
 *                  bibliographies of its Quarto book and the main library,
 *                  else the main library (#198). The editor renders the
 *                  citations of a Quarto chapter from the bibliography of the
 *                  book. The print window, the outline,
 *                  the preview of a wikilink and the Annotations view render
 *                  the same citations from the same files.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { leafIds, openInLeaf } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-document-bibliography-e2e-latest");

/** The main library of the settings. */
const MAIN_LIBRARY = `@book{Shared24,
  author = {Shared, Ada},
  title = {A Shared Bibliography Entry},
  year = {2024},
}
`;

/** The bibliography that the manifest of the book names. */
const BOOK_LIBRARY = `@book{Conway88,
  author = {Conway, John},
  title = {Sphere Packings, Lattices and Groups},
  year = {1988},
}
`;

/** The bibliography that the front matter of two notes names by a relative path. */
const NOTE_LIBRARY = `@book{Milnor73,
  author = {Milnor, John},
  title = {Symmetric Bilinear Forms},
  year = {1973},
}
`;

const MANIFEST = [
  "project:",
  "  type: book",
  "book:",
  "  title: Lattices",
  "  chapters:",
  "    - chapter.md",
  "bibliography: book.bib",
  "",
].join("\n");

const CHAPTER = "# Packings [@Conway88]\n\nThe Leech lattice gives a dense packing [@Conway88].\n";
const LIST_NOTE =
  "---\nbibliography: [./refs.bib]\n---\n\n# Forms\n\nEach even form has a signature that 8 divides [@Milnor73].\n";
const STRING_NOTE = "---\nbibliography: refs.bib\n---\n\n# Forms [@Milnor73]\n\nA second note.\n";
const PLAIN = "# Results [@Shared24]\n\nSee [[chapter]] for the packings.\n";

const DRAWER = "#navigation-sidebar";
const SECTION = (id: string): string => `${DRAWER} [data-section="${id}"]`;
const OUTLINE_ENTRY = `${SECTION("outline")} .toc-entry`;
const EDITOR = ".cm-content:visible";

/** Waits until a condition holds, and answers whether it held. */
async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await delay(200);
  }
  return await condition();
}

function printPages(browser: Browser): Page[] {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => !candidate.isClosed() && candidate.url().includes("/print/"));
}

describe("the bibliography of a document", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let chapterPath = "";
  let listNotePath = "";
  let stringNotePath = "";
  let plainPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-document-bibliography-e2e-", {
      documentName: "plain.md",
      documentContents: PLAIN,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    plainPath = fixture.documentPath;
    const workspace = path.dirname(plainPath);

    const book = path.join(workspace, "book");
    await mkdir(book);
    chapterPath = path.join(book, "chapter.md");
    await writeFile(path.join(book, "_quarto.yml"), MANIFEST, "utf8");
    await writeFile(path.join(book, "book.bib"), BOOK_LIBRARY, "utf8");
    await writeFile(chapterPath, CHAPTER, "utf8");

    listNotePath = path.join(workspace, "list.md");
    stringNotePath = path.join(workspace, "string.md");
    await writeFile(listNotePath, LIST_NOTE, "utf8");
    await writeFile(stringNotePath, STRING_NOTE, "utf8");
    await writeFile(path.join(workspace, "refs.bib"), NOTE_LIBRARY, "utf8");

    const mainLibrary = path.join(fixture.root, "main.bib");
    await writeFile(mainLibrary, MAIN_LIBRARY, "utf8");
    const configPath = path.join(fixture.configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.export = { cslLibrary: mainLibrary, cslStyle: "" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    // The chapter is open at the start: the workspace walk has not listed
    // its folder when the editor and the views first ask for its library.
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout(), {
      files: [chapterPath],
    });
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(EDITOR).waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    for (const printPage of printPages(requireInitialized(browser, "browser"))) {
      const closed = printPage.waitForEvent("close", { timeout: 10_000 });
      await requestWindowClose(printPage);
      await closed;
    }
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

  /** Makes a document the active document of the window. */
  async function activate(documentPath: string): Promise<Page> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const [leafId] = await leafIds(editorPage);
    await openInLeaf(editorPage, leafId, documentPath);
    const name = path.basename(documentPath);
    assert.ok(
      await until(
        async () =>
          (await editorPage
            .locator(
              `[data-path="${documentPath}"].active, .tab-container .active[title*="${name}"]`,
            )
            .count()) > 0 || (await editorPage.evaluate(() => document.title)).includes(name),
        20_000,
      ),
      `${name} is the active document`,
    );
    return editorPage;
  }

  /** Opens the print window of a document, and answers the text of its last paragraph. */
  async function printedParagraph(documentPath: string, screenshot: string): Promise<string> {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.evaluate(async (filePath) => {
      await window.ipc.invoke("application", { command: "print", payload: filePath });
    }, documentPath);
    const openBrowser = requireInitialized(browser, "browser");
    const deadline = Date.now() + 20_000;
    let printPage = printPages(openBrowser)[0];
    while (printPage === undefined) {
      assert.ok(Date.now() < deadline, "the print window opened");
      await delay(100);
      printPage = printPages(openBrowser)[0];
    }
    const paragraph = printPage.locator("#print-container p").last();
    await paragraph.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set(screenshot, await printPage.screenshot());
    const text = (await paragraph.innerText()).replace(/\s+/g, " ");
    const closed = printPage.waitForEvent("close", { timeout: 10_000 });
    await requestWindowClose(printPage);
    await closed;
    return text;
  }

  it("renders a citation of a Quarto chapter in the editor from the bibliography of the book", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const citation = editorPage.locator(".citeproc-citation").last();
    assert.ok(
      await until(async () => (await citation.innerText()) === "(Conway 1988)", 30_000),
      `the editor renders the citation: ${await citation.innerText()}`,
    );
  });

  it("prints a citation of a Quarto chapter from the bibliography of the book", async function () {
    assert.equal(
      await printedParagraph(chapterPath, "print-chapter.png"),
      "The Leech lattice gives a dense packing (Conway 1988).",
    );
  });

  it("prints a citation from a relative bibliography list of the front matter", async function () {
    assert.equal(
      await printedParagraph(listNotePath, "print-list-note.png"),
      "Each even form has a signature that 8 divides (Milnor 1973).",
    );
  });

  it("renders the outline of each document with the bibliography of that document", async function () {
    const editorPage = await activate(chapterPath);
    // The Explorer is the view of the drawer at the start; a click on its
    // icon while it is shown closes the drawer.
    if ((await editorPage.locator(`${DRAWER}[data-view="explorer"]`).count()) === 0) {
      await editorPage.locator('#activity-bar [data-activity="explorer"]').click();
      await editorPage.locator(`${DRAWER}[data-view="explorer"]`).waitFor({ timeout: 10_000 });
    }
    if ((await editorPage.locator(`${SECTION("outline")}[data-state="open"]`).count()) === 0) {
      await editorPage.locator(`${SECTION("outline")} .chrome-section-trigger`).click();
      await editorPage
        .locator(`${SECTION("outline")}[data-state="open"]`)
        .waitFor({ timeout: 10_000 });
    }
    const entry = editorPage.locator(OUTLINE_ENTRY).first();

    const outlineOf = async (documentPath: string, expected: string): Promise<void> => {
      await activate(documentPath);
      assert.ok(
        await until(
          async () => (await entry.innerText()).replace(/\s+/g, " ").includes(expected),
          20_000,
        ),
        `the outline of ${path.basename(documentPath)} shows "${expected}": ${await entry.innerText()}`,
      );
    };

    await outlineOf(chapterPath, "Packings (Conway 1988)");
    await outlineOf(stringNotePath, "Forms (Milnor 1973)");
    // A document without a bibliography after one with refs.bib has the main library.
    await outlineOf(plainPath, "Results (Shared 2024)");
    screenshots.set("outline-plain.png", await editorPage.screenshot());
  });

  it("renders a citation in the preview of a wikilink with the bibliography of the linked document", async function () {
    const editorPage = await activate(plainPath);
    const link = editorPage.locator(`${EDITOR} :text("chapter")`).first();
    await link.waitFor({ state: "visible", timeout: 20_000 });
    await link.hover();
    const preview = editorPage.locator(".editor-note-preview .note-content");
    assert.ok(
      await until(
        async () =>
          (await preview.count()) > 0 &&
          (await preview.innerText()).includes("The Leech lattice gives a dense packing"),
        20_000,
      ),
      "the preview of the chapter is shown",
    );
    screenshots.set("wikilink-preview.png", await editorPage.screenshot());
    assert.ok(
      (await preview.innerText()).replace(/\s+/g, " ").includes("dense packing (Conway 1988)."),
      `the preview renders the citation: ${await preview.innerText()}`,
    );
  });

  it("renders a citation in the quoted text of an annotation with the bibliography of its document", async function () {
    const editorPage = await activate(chapterPath);
    const from = CHAPTER.indexOf("dense packing");
    const to = CHAPTER.indexOf("].", from) + 1;
    const created: unknown = await editorPage.evaluate(
      async (input) => {
        const session = await window.ipc.invoke("documents-provider", {
          command: "get-collaboration-session",
          payload: { path: input.path },
        });
        if (session === undefined) {
          throw new Error(`The provider holds no collaboration session for ${input.path}`);
        }
        return await window.ipc.invoke("documents:create-annotation", {
          ...input,
          expectedAnnotationGeneration: session.annotations.generation,
        });
      },
      { path: chapterPath, from, to, instruction: "Name the density." },
    );
    assert.ok(
      typeof created === "object" && created !== null && "annotationId" in created,
      `the annotation was created: ${JSON.stringify(created)}`,
    );
    await editorPage.locator('#panel-activity-bar [data-activity="annotations"]').click();
    const context = editorPage.locator(".annotation-workspace-context").first();
    assert.ok(
      await until(
        async () =>
          (await context.count()) > 0 && (await context.innerText()).includes("dense packing"),
        20_000,
      ),
      "the Annotations view shows the quoted text",
    );
    screenshots.set("annotation-context.png", await editorPage.screenshot());
    assert.equal(
      (await context.innerText()).replace(/\s+/g, " ").trim(),
      "dense packing (Conway 1988)",
    );
  });
});

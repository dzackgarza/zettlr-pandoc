/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Print window refusal E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The author opens the print window on a document that it
 *                  cannot show: a document with a citation while the
 *                  citation style does not load, and a file that the
 *                  filesystem refuses to read. The print window names the
 *                  cause in one message and shows no part of the document.
 *                  A print of another document while a print window is open
 *                  replaces that window.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-print-refusal-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

const LIBRARY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;

async function findPrintPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.isClosed() && candidate.url().includes("/print/"));
    if (page !== undefined) {
      return page;
    }
    await delay(100);
  }
  throw new Error("The print window did not open");
}

describe("a print window for a document that it cannot show", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let resources = "";
  let missingStyle = "";
  let fibers = "";
  let genus = "";
  let locked = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    resources = await mkdtemp(path.join(tmpdir(), "zettlr-print-refusal-resources-"));
    const library = path.join(resources, "references.bib");
    await writeFile(library, LIBRARY);
    missingStyle = path.join(resources, "unmounted", "journal.csl");

    const fixture = await createFixture("zettlr-print-refusal-e2e-", {
      documentName: "fibers.md",
      documentContents: "# Fibers\n\nStable reduction of curves is in [@AW71].\n",
      config: { darkMode: false, export: { cslLibrary: library, cslStyle: missingStyle } },
    });
    fixtureRoot = fixture.root;
    fibers = fixture.documentPath;
    genus = path.join(path.dirname(fibers), "genus.md");
    locked = path.join(path.dirname(fibers), "locked.md");
    await writeFile(genus, "# Genus\n\nTwo forms of one genus.\n", "utf8");
    await writeFile(locked, "# Locked\n\nA note that the filesystem refuses.\n", "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
  });

  after(async function () {
    // The application quits when its last window closes, so the print window
    // closes before the main window does. A run whose app did not start has
    // no window.
    if (browser !== undefined) {
      const printPages = browser
        .contexts()
        .flatMap((context) => context.pages())
        .filter((candidate) => !candidate.isClosed() && candidate.url().includes("/print/"));
      for (const printPage of printPages) {
        const closed = printPage.waitForEvent("close", { timeout: 10_000 });
        await requestWindowClose(printPage);
        await closed;
      }
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
      await chmod(locked, 0o644);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    await rm(resources, { recursive: true, force: true });
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  /** Opens the print window on a file, and answers the window. */
  async function print(file: string): Promise<Page> {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage.evaluate(async (filePath) => {
      await window.ipc.invoke("application", { command: "print", payload: filePath });
    }, file);
    const openBrowser = requireInitialized(browser, "browser");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const printPage = await findPrintPage(openBrowser, 20_000);
      if (new URL(printPage.url()).searchParams.get("file") === file) {
        return printPage;
      }
      await delay(100);
    }
    throw new Error(`No print window for ${file} appeared`);
  }

  /** Opens the print window on a file and answers its one message and the uncaught errors. */
  async function printAndRead(
    file: string,
    screenshot: string,
  ): Promise<{ messages: string[]; uncaught: string[]; html: string }> {
    const printPage = await print(file);
    const uncaught: string[] = [];
    printPage.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Uncaught")) {
        uncaught.push(message.text());
      }
    });
    printPage.on("pageerror", (error) => uncaught.push(error.message));

    const error = printPage.locator(`${ERROR_TOAST} span:first-child`);
    await error.first().waitFor({ state: "visible", timeout: 30_000 });
    // The window gets no second message for the same refusal.
    await delay(1000);
    screenshots.set(screenshot, await printPage.screenshot());
    const messages = await error.allInnerTexts();
    const html = await printPage.locator("#print-container").innerHTML();
    return { messages, uncaught, html };
  }

  it("names the citation style that did not load", async function () {
    const { messages, uncaught, html } = await printAndRead(fibers, "style-refused.png");
    assert.equal(messages.length, 1, "the print window shows one message");
    assert.ok(messages[0].includes(missingStyle), `the message names the style: ${messages[0]}`);
    assert.equal(html.trim(), "", "the print window shows no part of the document");
    assert.deepEqual(uncaught, []);
  });

  it("replaces the print window with the window of another document", async function () {
    const printPage = await print(genus);
    const heading = printPage.locator("#print-container h1");
    await heading.waitFor({ state: "visible", timeout: 20_000 });
    screenshots.set("replaced.png", await printPage.screenshot());
    assert.equal(await heading.innerText(), "Genus");
    const printPages = requireInitialized(browser, "browser")
      .contexts()
      .flatMap((context) => context.pages())
      .filter((candidate) => !candidate.isClosed() && candidate.url().includes("/print/"));
    assert.equal(printPages.length, 1, "one print window is open");
  });

  it("names the file that the filesystem refuses to read", async function () {
    await chmod(locked, 0o000);
    const { messages, uncaught, html } = await printAndRead(locked, "file-refused.png");
    assert.equal(messages.length, 1, "the print window shows one message");
    assert.ok(messages[0].includes(locked), `the message names the file: ${messages[0]}`);
    assert.equal(html.trim(), "", "the print window shows no part of the document");
    assert.deepEqual(uncaught, []);
  });
});

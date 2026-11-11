/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation library thread E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the packaged app, whose thread program of a
 *                  citation library is a file of its own in `app.asar`. The
 *                  app reads the main library on that thread. A document
 *                  names a bibliography that is absent: the app starts, the
 *                  main window names the file and the cause, and the editor
 *                  renders no citation. When the file appears, the app reads
 *                  it, the problem ends and the editor renders the citation
 *                  (#138).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import {
  type AgentClient,
  agentClient,
  assertCleanExit,
  createFixture,
  currentPackagedBinary,
  delay,
  findEditorPage,
  observeRenderer,
  preserveArtifacts,
  readAgentApiPort,
  readAppLog,
  requireInitialized,
  shutdown,
  waitForDevTools,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-citation-thread-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const CITATION = ".cm-content .citeproc-citation";

const MAIN_LIBRARY = `@article{Nik80,
  title = {Integral Symmetric Bilinear Forms and Some of Their Applications},
  author = {Nikulin, V. V.},
  year = 1980,
  journal = {Mathematics of the USSR-Izvestiya},
  volume = {14},
  pages = {103--167},
}
`;

const DOCUMENT_BIBLIOGRAPHY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;

// A style that renders a citation as the year in square brackets.
const YEAR_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbib/csl" class="in-text" version="1.0">
  <info>
    <title>Year in brackets</title>
    <id>https://example.org/year-in-brackets</id>
    <updated>2026-01-01T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="[" suffix="]" delimiter="; ">
      <date variable="issued"><date-part name="year"/></date>
    </layout>
  </citation>
  <bibliography>
    <layout><text variable="title"/></layout>
  </bibliography>
</style>
`;

interface Problem {
  resource: string;
  path: string;
  cause: string;
}

/** The message of the failure that the read permission check of this absent file gives. */
async function accessFailure(file: string): Promise<string> {
  const error: Error = await access(file, constants.R_OK).then(
    () => new Error(`${file} is readable`),
    (cause: Error) => cause,
  );
  return error.message;
}

async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await delay(100);
  }
  return await condition();
}

/** The citation resource problems, as a window reads them. */
function problemsReadByTheWindow(page: Page): Promise<Problem[]> {
  return page.evaluate(
    async () =>
      (await window.ipc.invoke("citeproc-provider", { command: "get-problems" })) as Problem[],
  );
}

describe("packaged app: a citation library is read on a thread of its own", function () {
  this.timeout(300_000);

  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let agent: AgentClient | undefined;
  let fixtureRoot: string | undefined;
  let resources = "";
  let documentBibliography = "";
  let processOutput = "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const binary = currentPackagedBinary();
    resources = await mkdtemp(path.join(tmpdir(), "zettlr-citation-thread-resources-"));
    const mainLibrary = path.join(resources, "references.bib");
    await writeFile(mainLibrary, MAIN_LIBRARY);
    const yearStyle = path.join(resources, "year.csl");
    await writeFile(yearStyle, YEAR_STYLE);
    documentBibliography = path.join(resources, "chapter.bib");

    const fixture = await createFixture("zettlr-citation-thread-e2e-", {
      documentName: "fibers.md",
      documentContents: `---\nbibliography: ${documentBibliography}\n---\n\n# Fibers\n\nStable reduction of curves is in [@AW71].\n\nThe end.\n`,
      config: {
        agentApi: { enabled: true, port: 0 },
        export: { cslLibrary: mainLibrary, cslStyle: yearStyle },
      },
    });
    fixtureRoot = fixture.root;
    appProcess = spawn(
      binary,
      [
        `--data-dir=${fixture.configDirectory}`,
        "--remote-debugging-port=0",
        "--disable-hardware-acceleration",
        "--ozone-platform=x11",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const appendOutput = (chunk: Buffer): void => {
      processOutput = `${processOutput}${chunk.toString()}`.slice(-200_000);
    };
    appProcess.stdout?.on("data", appendOutput);
    appProcess.stderr?.on("data", appendOutput);
    browser = await chromium.connectOverCDP(
      await waitForDevTools(appProcess, () => processOutput, this.timeout()),
    );
    page = await findEditorPage(browser, this.timeout());
    observeRenderer(page, rendererEvents);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    agent = agentClient(await readAgentApiPort(fixture.configDirectory, 60_000));
  });

  after(async function () {
    await shutdown(browser, appProcess);
    // The packaged app writes its log to a file, not to its output.
    const log =
      fixtureRoot === undefined
        ? processOutput
        : `${processOutput}\n${await readAppLog(fixtureRoot)}`;
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      processOutput,
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    await rm(resources, { recursive: true, force: true });
    assertCleanExit(log);
  });

  it("names the bibliography of a document that is absent, and renders no citation", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const cause = await accessFailure(documentBibliography);

    const toast = editorPage.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("bibliography-problem-toast.png", await editorPage.screenshot());
    assert.equal(await toast.count(), 1, "one problem shows one message");
    const message = await toast.first().locator("span:first-child").innerText();
    assert.ok(message.includes(documentBibliography), `the message names the file: ${message}`);
    assert.ok(message.includes(cause), `the message names the cause: ${message}`);
    assert.equal(
      await toast.first().locator("[data-toast-action]").count(),
      0,
      "no setting names the bibliography of a document",
    );
    assert.deepEqual(await problemsReadByTheWindow(editorPage), [
      { resource: "bibliography", path: documentBibliography, cause },
    ]);

    const citation = editorPage.locator(CITATION);
    await citation.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await citation.innerText(), "[@AW71]", "the editor shows the source");
  });

  it("reads the main library of the setting", async function () {
    const api = requireInitialized(agent, "The Agent API must be up");

    assert.deepEqual(
      await api.post("/v1/citations/render", { mode: "citation", citations: [{ id: "Nik80" }] }),
      { rendered: "[1980]" },
    );
  });

  it("reads the bibliography when its file appears, and renders the citation", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");

    await writeFile(documentBibliography, DOCUMENT_BIBLIOGRAPHY);

    const citation = editorPage.locator(CITATION);
    assert.ok(
      await until(async () => (await citation.innerText()) === "[1971]", 30_000),
      `the editor renders the citation: ${await citation.innerText()}`,
    );
    screenshots.set("bibliography-loaded.png", await editorPage.screenshot());
    assert.deepEqual(await problemsReadByTheWindow(editorPage), []);
  });
});

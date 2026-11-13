/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unreadable citation style E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the assembled app with `export.cslStyle` at a file
 *                  that is absent. The app starts. The main window names the
 *                  path and the cause and opens the setting, the Preferences
 *                  window marks the field, the editor and the References view
 *                  render no citation in another style, and the Agent API
 *                  refuses a render with its own error code. A setting that
 *                  names a style that loads ends each of these (#76).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  type AgentClient,
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  readAgentApiPort,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-citation-style-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const STYLE_FIELD = '[id="field-input-export.cslStyle"]';
const CITATION = ".cm-content .citeproc-citation";

const LIBRARY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;

// A style that renders a citation as the year in square brackets, and a
// bibliography entry as the title.
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

const DOCUMENT = "# Fibers\n\nStable reduction of curves is in [@AW71].\n\nThe end.\n";
const RENDER = { mode: "citation", citations: [{ id: "AW71" }] };

/** The message of the failure that a read of this absent file gives. */
async function readFailure(file: string): Promise<string> {
  const error: Error = await readFile(file, "utf8").then(
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

function preferencesPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/preferences/"));
}

/** The ids of the inputs whose fields the Preferences window marks as not loaded. */
function markedFields(preferences: Page): Promise<string[]> {
  return preferences.evaluate(() =>
    [...document.querySelectorAll(".file-problem")].map((mark) => {
      const input = mark.closest(".form-control")?.querySelector("input");
      if (input === null || input === undefined) {
        throw new Error("A problem mark is not in the field of an input");
      }
      return input.id;
    }),
  );
}

describe("assembled app: a citation style that cannot be loaded", function () {
  this.timeout(300_000);

  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let agent: AgentClient | undefined;
  let fixtureRoot: string | undefined;
  let resources = "";
  let missingStyle = "";
  let yearStyle = "";
  let toastMessage = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    resources = await mkdtemp(path.join(tmpdir(), "zettlr-citation-style-resources-"));
    const library = path.join(resources, "references.bib");
    await writeFile(library, LIBRARY);
    yearStyle = path.join(resources, "year.csl");
    await writeFile(yearStyle, YEAR_STYLE);
    missingStyle = path.join(resources, "unmounted", "journal.csl");

    const fixture = await createFixture("zettlr-citation-style-e2e-", {
      documentName: "fibers.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true },
        agentApi: { enabled: true, port: 0 },
        export: { cslLibrary: library, cslStyle: missingStyle },
      },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    agent = agentClient(await readAgentApiPort(fixture.configDirectory, 60_000));
  });

  after(async function () {
    // The app runs while a window is open.
    await (browser === undefined ? undefined : preferencesPage(browser))?.close();
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
    await rm(resources, { recursive: true, force: true });
    assertCleanExit(getOutput());
  });

  it("starts, names the path and the cause, and opens the setting", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const cause = await readFailure(missingStyle);

    const toast = editorPage.locator(ERROR_TOAST);
    const action = toast.first().locator("[data-toast-action]");
    await action.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("style-problem-toast.png", await editorPage.screenshot());
    assert.equal(await toast.count(), 1, "one problem shows one message");
    toastMessage = await toast.first().locator("span:first-child").innerText();
    assert.ok(toastMessage.includes(missingStyle), `the message names the file: ${toastMessage}`);
    assert.ok(toastMessage.includes(cause), `the message names the cause: ${toastMessage}`);
    assert.equal(await action.innerText(), "Open Preferences");

    await action.click();
    const openBrowser = requireInitialized(browser, "The app must be attached");
    assert.ok(
      await until(async () => preferencesPage(openBrowser) !== undefined, 30_000),
      "the action opens the Preferences window",
    );
    const preferences = requireInitialized(
      preferencesPage(openBrowser),
      "The Preferences window must be open",
    );
    const field = preferences.locator(STYLE_FIELD);
    await field.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await field.inputValue(), missingStyle, "the window shows the setting");
    const mark = preferences.locator(".file-problem");
    await mark.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("style-problem-preferences.png", await preferences.screenshot());
    assert.deepEqual(await markedFields(preferences), ["field-input-export.cslStyle"]);
    assert.ok(
      (await mark.innerText()).includes(cause),
      `the field names the cause: ${await mark.innerText()}`,
    );
  });

  it("renders no citation in another style", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const api = requireInitialized(agent, "The Agent API must be up");

    const citation = editorPage.locator(CITATION);
    await citation.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(
      await until(
        async () => (await citation.getAttribute("class"))?.split(" ").includes("error") === true,
        30_000,
      ),
      "the editor marks the citation as not rendered",
    );
    assert.equal(await citation.innerText(), "[@AW71]", "the editor shows the source");

    await editorPage.locator('#activity-bar [data-activity="references"]').click();
    const failure = editorPage.locator("#references-panel .references-failure");
    await failure.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("style-problem-references.png", await editorPage.screenshot());
    assert.ok(toastMessage.includes(missingStyle), "the first case read the message of the toast");
    assert.equal(
      await failure.innerText(),
      toastMessage,
      "the References view names the file and the cause in the words of the toast",
    );
    assert.equal(
      await editorPage.locator("#references-panel .csl-entry").count(),
      0,
      "the References view lists no entry",
    );

    const refused = await api.postExpectingFailure("/v1/citations/render", RENDER);
    assert.equal(refused.status, 503);
    const body = refused.body as { error: { code: string; message: string } };
    assert.equal(body.error.code, "CITATION_STYLE_NOT_LOADED");
    assert.ok(
      body.error.message.includes(missingStyle),
      `the refusal names the file: ${body.error.message}`,
    );
  });

  it("renders in the style of the setting when the setting names a style that loads", async function () {
    const editorPage = requireInitialized(page, "The editor window must be open");
    const api = requireInitialized(agent, "The Agent API must be up");
    const preferences = requireInitialized(
      preferencesPage(requireInitialized(browser, "The app must be attached")),
      "The Preferences window must be open",
    );

    await preferences.locator(STYLE_FIELD).fill(yearStyle);

    assert.ok(
      await until(async () => (await markedFields(preferences)).length === 0, 30_000),
      "the field has no mark for a style that loads",
    );
    screenshots.set("style-loaded-preferences.png", await preferences.screenshot());

    const citation = editorPage.locator(CITATION);
    assert.ok(
      await until(async () => (await citation.innerText()) === "[1971]", 30_000),
      `the editor renders the citation in the new style: ${await citation.innerText()}`,
    );
    const entry = editorPage.locator("#references-panel .csl-entry");
    await entry.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("style-loaded-references.png", await editorPage.screenshot());
    assert.equal(
      await entry.innerText(),
      "Degenerate Fibers and Stable Reduction of Curves",
      "the References view lists the entry in the new style",
    );
    assert.equal(
      await editorPage.locator("#references-panel .references-failure").count(),
      0,
      "the References view shows no cause",
    );

    assert.deepEqual(await api.post("/v1/citations/render", RENDER), { rendered: "[1971]" });
  });
});

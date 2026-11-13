/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        HTML export of the packaged app E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the packaged app and exports a document with the
 *                  HTML profile. The export gives Pandoc the MathJax of the
 *                  application, which Pandoc puts into the file; Pandoc is a
 *                  process of its own and reads no file inside `app.asar`.
 *                  The exported file, opened in Chromium, shows each formula
 *                  of the document as typeset math, also a formula between
 *                  \( and \) (#199).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import type { PandocProfileMetadata } from "source/app/service-providers/assets";
import {
  AGENT_API_ENVIRONMENT,
  assertCleanExit,
  createFixture,
  currentPackagedBinary,
  findEditorPage,
  observeRenderer,
  preserveArtifacts,
  readAppLog,
  requireInitialized,
  shutdown,
  waitForDevTools,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-html-export-packaged-e2e-latest");
const PROFILE = "HTML.yaml";
const DOCUMENT = "# Genus\n\nThe real line $\\mathbb{R}$ holds the variable \\(x\\).\n";

/** The scene of the visual specs: Electron's Chromium in a window of its own. */
interface Scene {
  page: Page;
  close: () => Promise<void>;
}

describe("packaged app: an HTML export typesets its math", function () {
  this.timeout(300_000);

  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let processOutput = "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const binary = currentPackagedBinary();
    const fixture = await createFixture("zettlr-html-export-packaged-e2e-", {
      documentName: "genus.md",
      documentContents: DOCUMENT,
      config: { darkMode: false, export: { dir: "cwd", autoOpenExportedFiles: false } },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    appProcess = spawn(
      binary,
      [
        `--data-dir=${fixture.configDirectory}`,
        "--remote-debugging-port=0",
        "--disable-hardware-acceleration",
        "--ozone-platform=x11",
      ],
      {
        detached: true,
        env: { ...process.env, ...AGENT_API_ENVIRONMENT },
        stdio: ["ignore", "pipe", "pipe"],
      },
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
  });

  after(async function () {
    await shutdown(browser, appProcess);
    // The packaged app writes its log to a file, not to its output.
    const log =
      fixtureRoot === undefined
        ? processOutput
        : `${processOutput}\n${await readAppLog(fixtureRoot)}`;
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixtureRoot, log, rendererEvents, screenshots);
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(log);
  });

  it("exports the document to an HTML file whose formulas MathJax typesets", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const exported = path.join(path.dirname(documentPath), "genus.html");

    // The call that the export launcher of the main window makes.
    await editorPage.evaluate(
      async ({ file, name }) => {
        const profiles: PandocProfileMetadata[] = await window.ipc.invoke("assets-provider", {
          command: "list-export-profiles",
        });
        const profile = profiles.find((candidate) => candidate.name === name);
        if (profile === undefined || profile.isInvalid) {
          throw new Error(`The application has no valid profile ${name}`);
        }
        await window.ipc.invoke("application", {
          command: "export",
          payload: { file, profile, exportTo: "cwd" },
        });
      },
      { file: documentPath, name: PROFILE },
    );
    assert.equal(existsSync(exported), true, "the document was exported to HTML");

    const { openScene }: { openScene: (options: object) => Promise<Scene> } = await import(
      "../test/visual/scene.mjs"
    );
    const scene = await openScene({
      width: 800,
      height: 600,
      userData: path.join(requireInitialized(fixtureRoot, "The fixture exists"), "scene"),
    });
    await scene.page.goto(pathToFileURL(exported).href);
    await scene.page.waitForFunction(
      () => document.querySelectorAll("mjx-container").length === 2,
      undefined,
      { timeout: 30_000 },
    );
    screenshots.set("exported-html.png", await scene.page.screenshot());
    const typeset = await scene.page.evaluate(() =>
      [...document.querySelectorAll("mjx-container")].map((math) => ({
        latex: math.querySelector("[data-latex]")?.getAttribute("data-latex"),
        errors: math.querySelectorAll("mjx-merror").length,
      })),
    );
    await scene.close();
    assert.deepEqual(typeset, [
      { latex: "\\mathbb{R}", errors: 0 },
      { latex: "x", errors: 0 },
    ]);
  });
});

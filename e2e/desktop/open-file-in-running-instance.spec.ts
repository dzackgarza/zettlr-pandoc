// Issue #52's second named behaviour: passing a file to the launcher while the
// app is already running must open that file in the running window, not merely
// focus it. The delivery is Electron's single-instance handshake, driven here
// through the production script the boot launcher calls
// (scripts/desktop/zettlr-pandoc-open-in-running) rather than a re-description
// of it, so the test fails if that script stops delivering.
import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  outputTail,
  preserveArtifacts,
  REPO_ROOT,
  requireInitialized,
  shutdown,
} from "../support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-open-in-running-e2e-latest");
const HANDOFF_SCRIPT = path.join(REPO_ROOT, "scripts", "desktop", "zettlr-pandoc-open-in-running");
const DELIVERED_MARKER = "ZETTLR_E2E_DELIVERED_DOCUMENT_MARKER_2F1A6C33";
const DELIVERED_CONTENTS = `# Delivered document\n\n${DELIVERED_MARKER}\n`;

interface HandoffResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/** Run the launcher's handoff script exactly as zettlr-pandoc-boot runs it. */
async function runHandoff(args: string[]): Promise<HandoffResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(HANDOFF_SCRIPT, args, {
      cwd: tmpdir(), // The script must not depend on being run from the repo.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

describe("opening a file while the app is already running", function () {
  this.timeout(180_000);

  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory: string | undefined;
  let openedDocumentPath: string | undefined;
  let deliveredDocumentPath: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-open-in-running-e2e-", {
      documentName: "already-open.md",
      documentContents: "# Already open\n\nThe document the app boots with.\n",
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    openedDocumentPath = fixture.documentPath;

    // Written into the workspace before launch so the app has it indexed, and
    // deliberately left out of documents.yaml: nothing opens it but the
    // handoff.
    deliveredDocumentPath = path.join(path.dirname(fixture.documentPath), "delivered.md");
    await writeFile(deliveredDocumentPath, DELIVERED_CONTENTS, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
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

  it("gains a tab for the delivered file without restarting the app", async function () {
    const editorPage = requireInitialized(page, "The editor page must exist");
    const dataDirectory = requireInitialized(configDirectory, "The config directory must exist");
    const deliveredPath = requireInitialized(
      deliveredDocumentPath,
      "The delivered document path must exist",
    );
    const bootDocumentPath = requireInitialized(
      openedDocumentPath,
      "The boot document path must exist",
    );
    const runningProcess = requireInitialized(appProcess, "The application process must exist");

    const tabs = editorPage.locator('div[role="tab"]');
    assert.equal(
      await tabs.count(),
      1,
      "The app must boot with exactly the one fixture document open.",
    );

    const handoff = await runHandoff([`--data-dir=${dataDirectory}`, deliveredPath]);
    assert.equal(
      handoff.code,
      0,
      `The handoff must exit cleanly once the running instance has the file.\n` +
        `signal=${String(handoff.signal)}\n${handoff.output}`,
    );

    const deliveredTab = editorPage.locator(`div[role="tab"][data-path="${deliveredPath}"]`);
    await deliveredTab.waitFor({ state: "visible", timeout: 60_000 });

    assert.equal(
      runningProcess.exitCode,
      null,
      "The running application must still be the process that was launched.",
    );
    assert.equal(
      await tabs.count(),
      2,
      "The delivered file must be added as a tab beside the open one.",
    );
    assert.equal(
      await editorPage.locator(`div[role="tab"][data-path="${bootDocumentPath}"]`).count(),
      1,
      "The document that was already open must survive the delivery.",
    );

    // The tab is the affordance; being the active document with the bytes from
    // disk in it is what "opens that document" means.
    const editor = editorPage.locator(".cm-content");
    const deliveredContents = await readFile(deliveredPath, "utf8");
    await editorPage.waitForFunction(
      (expected) => {
        const content = document.querySelector(".cm-content");
        if (content === null) {
          return false;
        }
        const tile = (
          content as HTMLElement & {
            cmTile?: {
              root?: {
                view?: { state?: { doc?: { toString(): string } } };
              };
            };
          }
        ).cmTile;
        return tile?.root?.view?.state?.doc?.toString() === expected;
      },
      deliveredContents,
      { timeout: 60_000 },
    );
    const activeDocument = await editor.evaluate((content) => {
      const tile = (
        content as HTMLElement & {
          cmTile?: { root?: { view?: { state?: { doc?: { toString(): string } } } } };
        }
      ).cmTile;
      const documentText = tile?.root?.view?.state?.doc?.toString();
      if (documentText === undefined) {
        throw new Error("Could not read the active CodeMirror document state");
      }
      return documentText;
    });
    assert.equal(
      activeDocument,
      deliveredContents,
      `The delivered file must be the active document.\n${outputTail(getOutput())}`,
    );
    assert.ok(
      (await editor.innerText()).includes(DELIVERED_MARKER),
      "The delivered document must be rendered in the editor.",
    );
    screenshots.set("delivered-tab.png", await editorPage.screenshot());
  });

  it("reports a failure rather than opening a second app when no instance holds the lock", async function () {
    const deliveredPath = requireInitialized(
      deliveredDocumentPath,
      "The delivered document path must exist",
    );
    // A data directory nothing is running against: the handshake finds no
    // holder, so this process is free to become the app itself -- which is the
    // silent wrong outcome, since the caller asked to add a tab to a live
    // window.
    const handoff = await runHandoff([
      `--data-dir=${path.join(
        requireInitialized(fixtureRoot, "The fixture root must exist"),
        "unclaimed",
      )}`,
      deliveredPath,
    ]);
    assert.notEqual(handoff.code, 0, `An undelivered file must fail loudly.\n${handoff.output}`);
    assert.match(handoff.output, /No running Zettlr instance accepted the arguments/);
  });
});

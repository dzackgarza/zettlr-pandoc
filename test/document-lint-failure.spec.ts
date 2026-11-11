/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Background lint of a document that Flowmark cannot lint
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Runs the REAL DocumentLintProvider with the REAL Flowmark.
 *                  The time limit of a Flowmark run is 1 ms, so each run ends
 *                  as a timeout. A reader of the cache gets the cause, and
 *                  the queue does not lint the same text with the same
 *                  inputs a second time. A new text and a retry start a new
 *                  run.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import DocumentLintProvider from "source/app/service-providers/document-lint";
import LogProvider from "source/app/service-providers/log";

const TEXT = "Residue ???\n";
/** No Flowmark process ends in this time. */
const NO_RUN_ENDS_MS = 1;
const USUAL_LIMIT_MS = 60_000;
/** A queued run with the 1 ms limit ends well inside this time. */
const SECOND_RUN_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a document that Flowmark cannot lint", function () {
  this.timeout(120_000);

  let root: string;
  let documentPath: string;
  let provider: DocumentLintProvider;
  let timeoutMs = NO_RUN_ENDS_MS;
  let drains = 0;

  /** Resolves when the queue drained this many times. */
  async function drained(count: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (drains < count) {
      assert.ok(Date.now() < deadline, `the queue drained ${drains} times, not ${count}`);
      await delay(50);
    }
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), "zettlr-document-lint-failure-"));
    const home = path.join(root, "home");
    const userDataDirectory = path.join(root, "user-data");
    documentPath = path.join(root, "workspace", "note.md");
    await mkdir(path.join(home, ".pandoc", "styles", "macros"), { recursive: true });
    await mkdir(path.join(home, ".pandoc", "templates", "css"), { recursive: true });
    await mkdir(userDataDirectory);
    await mkdir(path.dirname(documentPath));
    await writeFile(
      path.join(home, ".pandoc", "styles", "macros", "base.tex"),
      "\\newcommand{\\ZZ}{\\mathbb{Z}}\n",
    );
    await writeFile(
      path.join(home, ".pandoc", "templates", "css", "mathjax-macros.json"),
      JSON.stringify({ ZZ: "\\mathbb{Z}" }),
    );
    await writeFile(
      path.join(home, ".pandoc", "templates", "standalone-tikz.tex"),
      "\\documentclass{standalone}\n\\begin{document}\n$body$\n\\end{document}\n",
    );
    await writeFile(documentPath, TEXT);
    timeoutMs = NO_RUN_ENDS_MS;
    drains = 0;
    provider = new DocumentLintProvider({
      log: new LogProvider(),
      config: {
        get: () => ({
          export: { cslLibrary: "" },
          tikz: {
            dataDir: path.join(__dirname, "../packages/tikz-render/test/fixtures/tikz-data"),
            figuresDir: "",
          },
          editor: { lint: { flowmark: { timeoutMs } } },
        }),
      },
      buffers: { readMarkdownBufferContent: () => undefined, lastEditorInputAt: () => 0 },
      homeDirectory: home,
      env: {},
      userDataDirectory,
      onDrain: () => {
        drains += 1;
      },
    });
    await provider.boot();
  });

  afterEach(async function () {
    await provider.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("gives a reader the cause", async function () {
    const [queued] = await provider.lookup([{ path: documentPath, text: TEXT }]);
    assert.equal(queued.current, false);
    assert.equal(queued.failure, undefined, "no run of the document ended yet");
    await drained(1);

    const [failed] = await provider.lookup([{ path: documentPath, text: TEXT }]);
    assert.equal(failed.current, false);
    assert.equal(failed.record, undefined, "a run that failed is no result of the document");
    assert.equal(failed.failure?.kind, "flowmark-timeout", "the reader gets the cause");
  });

  it("does not lint the same text a second time", async function () {
    await provider.lookup([{ path: documentPath, text: TEXT }]);
    await drained(1);

    await provider.lookup([{ path: documentPath, text: TEXT }]);
    await delay(SECOND_RUN_MS);
    assert.equal(drains, 1, "the queue started no second run of the same text");
  });

  it("lints a new text of a document whose last run failed", async function () {
    await provider.lookup([{ path: documentPath, text: TEXT }]);
    await drained(1);
    await provider.lookup([{ path: documentPath, text: TEXT }]);

    const edited = `${TEXT}\nA second paragraph.\n`;
    const [lookup] = await provider.lookup([{ path: documentPath, text: edited }]);
    assert.equal(lookup.failure, undefined, "the failure belongs to the text before the edit");
    await drained(2);
  });

  it("lints the document again after a retry", async function () {
    await provider.lookup([{ path: documentPath, text: TEXT }]);
    await drained(1);

    timeoutMs = USUAL_LIMIT_MS;
    provider.retryFailedDocuments();
    const [queued] = await provider.lookup([{ path: documentPath, text: TEXT }]);
    assert.equal(queued.failure, undefined, "a retry forgets the cause");
    await drained(2);

    const [linted] = await provider.lookup([{ path: documentPath, text: TEXT }]);
    assert.equal(linted.current, true);
    assert.equal(linted.failure, undefined);
    assert.ok(
      linted.record?.diagnostics.some(
        (diagnostic) => diagnostic.rule === "document/authorial-residue",
      ),
      "the result is the lint of the document",
    );
  });
});

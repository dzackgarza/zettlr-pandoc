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
 *                  run. A retry also ends the refusal that a failed write of
 *                  the results leaves, and writes the results again.
 *
 *                  A second group runs the provider over the REAL FSAL: a
 *                  workspace document whose file cannot be read is named
 *                  with the cause, and the other documents have their lint.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import DocumentLintProvider from "source/app/service-providers/document-lint";
import type FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import { bootFsal } from "./fsal-seam";

const TEXT = "Residue ???\n";
/** No Flowmark process ends in this time. */
const NO_RUN_ENDS_MS = 1;
const USUAL_LIMIT_MS = 60_000;
/** A queued run with the 1 ms limit ends well inside this time. */
const SECOND_RUN_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The macro sources and the TikZ template that a Flowmark run reads. */
async function writeAuthoringHome(home: string): Promise<void> {
  await mkdir(path.join(home, ".pandoc", "styles", "macros"), { recursive: true });
  await mkdir(path.join(home, ".pandoc", "templates", "css"), { recursive: true });
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
}

describe("a document that Flowmark cannot lint", function () {
  this.timeout(120_000);

  let root: string;
  let documentPath: string;
  let userDataDirectory: string;
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
    userDataDirectory = path.join(root, "user-data");
    documentPath = path.join(root, "workspace", "note.md");
    await writeAuthoringHome(home);
    await mkdir(userDataDirectory);
    await mkdir(path.dirname(documentPath));
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
    await writeFile(documentPath, edited);
    const [lookup] = await provider.lookup([{ path: documentPath, text: edited }]);
    assert.equal(lookup.failure, undefined, "the failure belongs to the text before the edit");
    await drained(2);
  });

  it("lints the document again after a retry", async function () {
    await provider.lookup([{ path: documentPath, text: TEXT }]);
    await drained(1);

    timeoutMs = USUAL_LIMIT_MS;
    await provider.retry();
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

  it("writes the results again after a retry", async function () {
    timeoutMs = USUAL_LIMIT_MS;
    // The directory of the results is a file, so no result can be written.
    const aside = `${userDataDirectory}-aside`;
    await rename(userDataDirectory, aside);
    await writeFile(userDataDirectory, "not a directory");
    await provider.lint(documentPath, TEXT);
    const refusal = async (): Promise<unknown> =>
      await provider.lookup([{ path: documentPath, text: TEXT }]).then(
        () => undefined,
        (error: unknown) => error,
      );
    const deadline = Date.now() + 10_000;
    while ((await refusal()) === undefined) {
      assert.ok(Date.now() < deadline, "the failed write was not reported to a reader");
      await delay(100);
    }
    const drainsAtRefusal = drains;
    assert.ok(drainsAtRefusal > 0, "an open reader is told to ask again");

    await rm(userDataDirectory);
    await rename(aside, userDataDirectory);
    await provider.retry();

    const [lookup] = await provider.lookup([{ path: documentPath, text: TEXT }]);
    assert.equal(lookup.current, true, "the result of the document is kept");
    const cachePath = path.join(userDataDirectory, "document-lint-cache.json");
    const written = async (): Promise<boolean> =>
      await readFile(cachePath, "utf8").then(
        (contents) => contents.includes(documentPath),
        () => false,
      );
    const writeDeadline = Date.now() + 10_000;
    while (!(await written())) {
      assert.ok(Date.now() < writeDeadline, "the retry did not write the results");
      await delay(100);
    }
  });
});

describe("a workspace document whose file cannot be read", function () {
  this.timeout(120_000);

  const OTHER = "# Genera\n\nTwo forms of one genus.\n";
  let root: string;
  let notePath: string;
  let otherPath: string;
  let fsal: FSAL;
  let provider: DocumentLintProvider;
  let drains = 0;

  before(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), "zettlr-document-lint-unreadable-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const userDataDirectory = path.join(root, "user-data");
    notePath = path.join(workspace, "note.md");
    otherPath = path.join(workspace, "other.md");
    await writeAuthoringHome(home);
    await mkdir(userDataDirectory);
    await mkdir(workspace);
    await writeFile(notePath, "# Lattices\n\nAn even unimodular lattice.\n");
    await writeFile(otherPath, OTHER);
    await chmod(otherPath, 0o000);
    fsal = await bootFsal(workspace);
    provider = new DocumentLintProvider({
      log: new LogProvider(),
      config: {
        get: () => ({
          export: { cslLibrary: "" },
          tikz: {
            dataDir: path.join(__dirname, "../packages/tikz-render/test/fixtures/tikz-data"),
            figuresDir: "",
          },
          editor: { lint: { flowmark: { timeoutMs: USUAL_LIMIT_MS } } },
        }),
      },
      buffers: { readMarkdownBufferContent: () => undefined, lastEditorInputAt: () => 0 },
      fsal,
      homeDirectory: home,
      env: {},
      userDataDirectory,
      onDrain: () => {
        drains += 1;
      },
    });
    await provider.boot();
  });

  after(async function () {
    await provider.shutdown();
    await fsal.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("is named with the cause, and the other document has its lint", async function () {
    const problems = await provider.workspaceProblems({ scope: "all" });
    assert.equal(problems.documentCount, 2, "the document is a document of the workspace");
    assert.deepEqual(
      problems.failed.map((document) => document.path),
      [otherPath],
      "the reader gets the document that was not linted",
    );
    assert.deepEqual(problems.pendingPaths, [notePath], "the other document is in the queue");
  });

  it("is linted when the file can be read again", async function () {
    await chmod(otherPath, 0o600);
    const problems = await provider.workspaceProblems({ scope: "all" });
    assert.deepEqual(problems.failed, [], "the cause went away with the read");

    const deadline = Date.now() + 90_000;
    const linted = async (): Promise<boolean> =>
      (await provider.lookup([{ path: otherPath, text: OTHER }]))[0].current;
    while (!(await linted())) {
      assert.ok(Date.now() < deadline, `the document was not linted after ${drains} drains`);
      await delay(250);
    }
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Background lint queue and editor input
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Runs the REAL DocumentLintProvider over the REAL
 *                  DocumentManager. While an editor pushes updates to the
 *                  document authority, the background queue starts no
 *                  Flowmark run; when the input stops, the queue drains
 *                  (#139).
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { ChangeSet } from "@codemirror/state";
import { strict as assert } from "assert";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import DocumentLintProvider from "source/app/service-providers/document-lint";
import type DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import { bootDocumentManager } from "./documents-provider-seam";
import { ipcMainHandlers } from "./headless-electron-harness.cjs";

type AuthorityHandler = (event: undefined, message: unknown) => Promise<unknown>;

const ACTIVE_TEXT = "The author types in this document.\n";
const QUEUED_TEXT = "Residue ???\n";
const QUEUED_NAMES = ["first.md", "second.md", "third.md"];
const KEYSTROKE_INTERVAL_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Background lint queue while an editor receives input", function () {
  this.timeout(300_000);

  let root: string;
  let workspace: string;
  let activePath: string;
  let documents: DocumentManager;
  let lint: DocumentLintProvider;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-lint-idle-gate-"));
    const home = path.join(root, "home");
    const userDataDirectory = path.join(root, "user-data");
    workspace = path.join(root, "workspace");
    activePath = path.join(workspace, "active.md");
    await mkdir(path.join(home, ".pandoc", "styles", "macros"), { recursive: true });
    await mkdir(path.join(home, ".pandoc", "templates", "css"), { recursive: true });
    await mkdir(userDataDirectory);
    await mkdir(workspace);
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
    await writeFile(activePath, ACTIVE_TEXT);
    for (const name of QUEUED_NAMES) {
      await writeFile(path.join(workspace, name), QUEUED_TEXT);
    }

    documents = await bootDocumentManager(workspace);
    lint = new DocumentLintProvider({
      log: new LogProvider(),
      config: {
        get: () => ({
          export: { cslLibrary: "" },
          tikz: {
            dataDir: path.join(__dirname, "../packages/tikz-render/test/fixtures/tikz-data"),
            figuresDir: "",
          },
          editor: { lint: { flowmark: { timeoutMs: 60_000 } } },
        }),
      },
      buffers: documents,
      homeDirectory: home,
      env: {},
      userDataDirectory,
    });
    await lint.boot();
  });

  afterEach(async function () {
    await lint.shutdown();
    await documents.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("starts no queued document while the author types, and drains the queue afterwards", async function () {
    const authority = ipcMainHandlers.get("documents-authority") as AuthorityHandler | undefined;
    assert.ok(authority !== undefined, "the provider answers its editors");
    const { startVersion } = await documents.getDocument(activePath);
    let version = startVersion;
    let length = ACTIVE_TEXT.length;

    async function typeOneCharacter(): Promise<void> {
      const accepted = await authority?.(undefined, {
        command: "push-updates",
        payload: {
          filePath: activePath,
          version,
          updates: [
            {
              clientID: "editor-under-test",
              changes: ChangeSet.of({ from: 0, insert: "x" }, length).toJSON(),
            },
          ],
        },
      });
      assert.equal(accepted, true, "the provider takes the update of the editor");
      version += 1;
      length += 1;
    }

    // The time of one Flowmark run on this machine sets the time of typing:
    // the queue has time for each of its documents more than once.
    const lintStarted = Date.now();
    await lint.lint(activePath, ACTIVE_TEXT);
    const typingMs = Math.max(4_000, 3 * (Date.now() - lintStarted));

    const sources = QUEUED_NAMES.map((name) => ({
      path: path.join(workspace, name),
      text: QUEUED_TEXT,
    }));
    await typeOneCharacter();
    const queued = await lint.lookup(sources);
    assert.deepEqual(
      queued.map((lookup) => lookup.current),
      [false, false, false],
      "no queued document has a result at the start",
    );

    const typingEnds = Date.now() + typingMs;
    while (Date.now() < typingEnds) {
      await typeOneCharacter();
      await delay(KEYSTROKE_INTERVAL_MS);
    }
    await typeOneCharacter();

    const whileTyping = await lint.lookup(sources);
    assert.deepEqual(
      whileTyping.map((lookup) => lookup.record),
      [undefined, undefined, undefined],
      "the queue linted no document while the editor received input",
    );

    const deadline = Date.now() + 120_000;
    for (;;) {
      const afterTyping = await lint.lookup(sources);
      if (afterTyping.every((lookup) => lookup.current)) {
        for (const lookup of afterTyping) {
          assert.ok(
            lookup.record?.diagnostics.some(
              (diagnostic) => diagnostic.rule === "document/authorial-residue",
            ),
            "the queue linted the document after the input stopped",
          );
        }
        break;
      }
      assert.ok(Date.now() < deadline, "the queue did not drain after the input stopped");
      await delay(200);
    }
  });
});

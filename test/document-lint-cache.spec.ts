// This side-effect import must run before any main-process module import. It
// installs the headless Electron module shim that those imports consume.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import DocumentLintProvider from "source/app/service-providers/document-lint";
import LogProvider from "source/app/service-providers/log";

describe("document lint cache", function () {
  this.timeout(120_000);

  let root: string;
  let home: string;
  let userDataDirectory: string;
  let documentPath: string;
  const providers: DocumentLintProvider[] = [];
  const text = "Residue ???\n";

  function createProvider(): DocumentLintProvider {
    const provider = new DocumentLintProvider({
      log: new LogProvider(),
      config: {
        get: () => ({
          export: { cslLibrary: "" },
          tikz: {
            dataDir: path.join(__dirname, "../packages/tikz-workbench/test/fixtures/tikz-data"),
            figuresDir: "",
          },
          editor: { lint: { flowmark: { timeoutMs: 60_000 } } },
        }),
      },
      buffers: { readMarkdownBufferContent: () => undefined },
      homeDirectory: home,
      env: {},
      userDataDirectory,
      buildIdentity: "test",
    });
    providers.push(provider);
    return provider;
  }

  async function restarted(provider: DocumentLintProvider): Promise<DocumentLintProvider> {
    await provider.shutdown();
    const next = createProvider();
    await next.boot();
    return next;
  }

  async function currentLookup(provider: DocumentLintProvider, source: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const [lookup] = await provider.lookup([{ path: documentPath, text: source }]);
      if (lookup.current) {
        return lookup;
      }
      assert.ok(Date.now() < deadline, "the background linter did not bring the document up to date");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), "zettlr-document-lint-cache-"));
    home = path.join(root, "home");
    userDataDirectory = path.join(root, "user-data");
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
    await writeFile(documentPath, text);
  });

  afterEach(async function () {
    for (const provider of providers.splice(0)) {
      await provider.shutdown();
    }
    await rm(root, { recursive: true, force: true });
  });

  it("serves a persisted result after a restart without linting again", async function () {
    const first = createProvider();
    await first.boot();
    const linted = await first.lint(documentPath, text);
    assert.ok(
      linted.diagnostics.some((diagnostic) => diagnostic.rule === "document/authorial-residue"),
    );

    const second = await restarted(first);
    const [lookup] = await second.lookup([{ path: documentPath, text }]);
    assert.equal(lookup.current, true);
    assert.equal(lookup.record?.lintedAt, linted.lintedAt);
    assert.deepEqual(lookup.record?.diagnostics, linted.diagnostics);
    assert.equal((await second.lint(documentPath, text)).lintedAt, linted.lintedAt);
  });

  it("reports a document edited on disk as outdated and relints it in the background", async function () {
    const provider = createProvider();
    await provider.boot();
    const linted = await provider.lint(documentPath, text);

    const edited = "A clean sentence.\n";
    await writeFile(documentPath, edited);
    const [stale] = await provider.lookup([{ path: documentPath, text: edited }]);
    assert.equal(stale.current, false);
    assert.equal(stale.record?.lintedAt, linted.lintedAt);

    const fresh = await currentLookup(provider, edited);
    assert.notEqual(fresh.record?.lintedAt, linted.lintedAt);
    assert.ok(
      fresh.record?.diagnostics.every((diagnostic) => diagnostic.rule !== "document/authorial-residue"),
    );
  });

  it("reports a result as outdated when a macro source or the Flowmark config changes", async function () {
    const provider = createProvider();
    await provider.boot();
    const linted = await provider.lint(documentPath, text);

    await writeFile(
      path.join(home, ".pandoc", "styles", "macros", "base.tex"),
      "\\newcommand{\\ZZ}{\\mathbb{Z}}\n\\newcommand{\\QQ}{\\mathbb{Q}}\n",
    );
    const [afterMacros] = await provider.lookup([{ path: documentPath, text }]);
    assert.equal(afterMacros.current, false);
    const relinted = await currentLookup(provider, text);
    assert.notEqual(relinted.record?.lintedAt, linted.lintedAt);

    await writeFile(path.join(path.dirname(documentPath), ".flowmark.toml"), "");
    const [afterConfig] = await provider.lookup([{ path: documentPath, text }]);
    assert.equal(afterConfig.current, false);
  });
});

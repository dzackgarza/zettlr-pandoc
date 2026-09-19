import { strict as assert } from "assert";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { createDocumentLintContext, lintDocumentText } from "source/app/util/document-lint";

describe("main-process document lint", function () {
  this.timeout(30_000);

  let root: string;
  let home: string;
  let cacheDir: string;

  beforeEach(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), "zettlr-document-lint-"));
    home = path.join(root, "home");
    cacheDir = path.join(root, "cache");
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
  });

  afterEach(async function () {
    await rm(root, { recursive: true, force: true });
  });

  it("turns a real pdflatex TikZ failure into a document lint error", async function () {
    const repositoryRoot = path.join(__dirname, "..");
    const context = await createDocumentLintContext({
      homeDirectory: home,
      env: process.env,
      citationKeys: null,
      tikzRenderConfig: {
        tikzAssetDir: path.join(repositoryRoot, "static", "tikz"),
        templatePath: path.join(
          repositoryRoot,
          "static",
          "tikz",
          "templates",
          "standalone-tikz.tex",
        ),
        cacheDir,
        env: process.env,
      },
    });
    const markdown = [
      "\\begin{tikzcd}",
      "A \\arrow[r] & B \\thisMacroDoesNotExist",
      "\\end{tikzcd}",
      "",
    ].join("\n");

    const diagnostics = await lintDocumentText(markdown, path.join(root, "broken.md"), context);
    const compile = diagnostics.find((diagnostic) => diagnostic.source === "tikz-compile");
    assert.ok(compile !== undefined);
    assert.equal(compile.severity, "error");
    assert.equal(compile.rule, "tikz/compile-error");
    assert.match(compile.message, /Undefined control sequence/u);
  });
});

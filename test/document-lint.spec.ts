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
    const compile = diagnostics.find((diagnostic) => diagnostic.rule === "tikz/compile-error");
    assert.ok(compile !== undefined);
    assert.equal(compile.severity, "error");
    assert.equal(compile.rule, "tikz/compile-error");
  });

  it("keeps Pandoc multiline inline math intact through the real Flowmark lint subprocess", async function () {
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
      "summand of $B\\cong U\\oplus U\\oplus\\latI_{0,7}$; then $e^{\\perp B} = \\ZZ e\\oplus",
      "U\\oplus\\latI_{0,7}$ and $e^{\\perp}/e\\cong U\\oplus\\latI_{0,7}\\cong\\latI_{1,8}$,",
    ].join("\n");

    const diagnostics = await lintDocumentText(markdown, path.join(root, "math.md"), context);
    const structuralFailures = diagnostics
      .map((diagnostic) => diagnostic.rule)
      .filter((rule) =>
        rule === "pandoc/parse-error" ||
        rule === "math/unclosed-group" ||
        rule === "math/unmatched-group-close" ||
        rule === "math/unclosed-left" ||
        rule === "math/unmatched-right",
      );
    assert.deepEqual(structuralFailures, []);
  });

  it("carries a Flowmark fix to the source range it replaces", async function () {
    const repositoryRoot = path.join(__dirname, "..");
    const context = await createDocumentLintContext({
      homeDirectory: home,
      env: process.env,
      citationKeys: null,
      tikzRenderConfig: {
        tikzAssetDir: path.join(repositoryRoot, "static", "tikz"),
        templatePath: path.join(repositoryRoot, "static", "tikz", "templates", "standalone-tikz.tex"),
        cacheDir,
        env: process.env,
      },
    });
    const markdown = "Let $sin x = 0$.\n";

    const diagnostics = await lintDocumentText(markdown, path.join(root, "operator.md"), context);
    const operator = diagnostics.find((diagnostic) => diagnostic.rule === "math/bare-operator");
    assert.ok(operator !== undefined);
    assert.equal(markdown.slice(operator.from, operator.to), "sin");
    assert.deepEqual(operator.suggestions, [{ title: "Use `\\sin`", replacement: "\\sin" }]);
  });
});

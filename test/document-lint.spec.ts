import { strict as assert } from "assert";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { createDocumentLintContext, lintDocumentText } from "source/app/util/document-lint";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";

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
      flowmarkLintTimeoutMs: 60_000,
      tikzRenderConfig: {
        tikzAssetDir: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
        ),
        templatePath: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
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

    const { diagnostics } = await lintDocumentText(markdown, path.join(root, "broken.md"), context);
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
      flowmarkLintTimeoutMs: 60_000,
      tikzRenderConfig: {
        tikzAssetDir: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
        ),
        templatePath: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
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

    const { diagnostics } = await lintDocumentText(markdown, path.join(root, "math.md"), context);
    const structuralFailures = diagnostics
      .map((diagnostic) => diagnostic.rule)
      .filter(
        (rule) =>
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
      flowmarkLintTimeoutMs: 60_000,
      tikzRenderConfig: {
        tikzAssetDir: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
        ),
        templatePath: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
          "templates",
          "standalone-tikz.tex",
        ),
        cacheDir,
        env: process.env,
      },
    });
    const markdown = "Let $sin x = 0$.\n";

    const { diagnostics } = await lintDocumentText(
      markdown,
      path.join(root, "operator.md"),
      context,
    );
    const operator = diagnostics.find((diagnostic) => diagnostic.rule === "math/bare-operator");
    assert.ok(operator !== undefined);
    assert.equal(markdown.slice(operator.from, operator.to), "sin");
    assert.deepEqual(operator.suggestions, [{ title: "Use `\\sin`", replacement: "\\sin" }]);
  });

  it("positions a diagnostic on a later line by offset and by line and column", async function () {
    const repositoryRoot = path.join(__dirname, "..");
    const context = await createDocumentLintContext({
      homeDirectory: home,
      env: process.env,
      flowmarkLintTimeoutMs: 60_000,
      tikzRenderConfig: {
        tikzAssetDir: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
        ),
        templatePath: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
          "templates",
          "standalone-tikz.tex",
        ),
        cacheDir,
        env: process.env,
      },
    });
    const markdown = "# Title\n\nA first paragraph.\n\nThen let $x cos y = 0$ hold.\n";

    const { diagnostics } = await lintDocumentText(markdown, path.join(root, "lines.md"), context);
    const operator = diagnostics.find((diagnostic) => diagnostic.rule === "math/bare-operator");
    assert.ok(operator !== undefined);
    assert.equal(markdown.slice(operator.from, operator.to), "cos");
    assert.deepEqual(
      {
        line: operator.line,
        column: operator.column,
        endLine: operator.endLine,
        endColumn: operator.endColumn,
      },
      { line: 5, column: 13, endLine: 5, endColumn: 16 },
    );
  });

  it("checks citations against the bibliography files it is given", async function () {
    const repositoryRoot = path.join(__dirname, "..");
    const context = await createDocumentLintContext({
      homeDirectory: home,
      env: process.env,
      flowmarkLintTimeoutMs: 60_000,
      tikzRenderConfig: {
        tikzAssetDir: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
        ),
        templatePath: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
          "templates",
          "standalone-tikz.tex",
        ),
        cacheDir,
        env: process.env,
      },
    });
    const bibliography = path.join(root, "references.bib");
    await writeFile(
      bibliography,
      "@article{FS86, author={Friedman, Robert and Scattone, Francesco}, " +
        "title={Type III degenerations of K3 surfaces}, journal={Invent. Math.}, year={1986}}\n",
    );
    const markdown = "Following @FS86 and @FS87.\n";

    const { diagnostics } = await lintDocumentText(
      markdown,
      path.join(root, "chapter.md"),
      context,
      {
        bibliographies: [bibliography],
      },
    );
    const missing = diagnostics
      .filter((diagnostic) => diagnostic.rule === "citation/missing-bibliography-entry")
      .map((diagnostic) => markdown.slice(diagnostic.from, diagnostic.to));
    assert.deepEqual(missing, ["@FS87"]);
  });

  it("reports wikilinks by their workspace resolution, with a fix to the shortest unique name", async function () {
    const repositoryRoot = path.join(__dirname, "..");
    const workspace = path.join(root, "workspace");
    const document = (relative: string) => ({
      path: path.join(workspace, relative),
      root: workspace,
      id: "",
      title: undefined,
      aliases: [],
    });
    const context = await createDocumentLintContext({
      homeDirectory: home,
      env: process.env,
      flowmarkLintTimeoutMs: 60_000,
      wikilinks: new WikilinkIndex([
        document("chapters/doc.md"),
        document("programs/cusp-chain.md"),
        document("a/moduli.md"),
        document("b/moduli.md"),
      ]),
      tikzRenderConfig: {
        tikzAssetDir: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
        ),
        templatePath: path.join(
          repositoryRoot,
          "packages",
          "tikz-workbench",
          "test",
          "fixtures",
          "tikz-data",
          "templates",
          "standalone-tikz.tex",
        ),
        cacheDir,
        env: process.env,
      },
    });
    const markdown =
      "See [[../programs/cusp-chain.md#Main result|the chain]], [[moduli]], [[nowhere]] and [[cusp-chain]].\n";

    const { diagnostics } = await lintDocumentText(
      markdown,
      path.join(workspace, "chapters", "doc.md"),
      context,
    );
    const wikilinks = diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.rule.endsWith("wikilink") || diagnostic.rule.endsWith("wikilink-target"),
      )
      .map((diagnostic) => ({
        rule: diagnostic.rule,
        source: markdown.slice(diagnostic.from, diagnostic.to),
        fixes: diagnostic.suggestions?.map((suggestion) => suggestion.replacement),
      }));
    assert.deepEqual(wikilinks, [
      {
        rule: "link/relative-wikilink",
        source: "../programs/cusp-chain.md",
        fixes: ["cusp-chain"],
      },
      { rule: "link/ambiguous-wikilink", source: "moduli", fixes: ["a/moduli", "b/moduli"] },
      { rule: "link/missing-wikilink-target", source: "nowhere", fixes: [] },
    ]);
  });
});

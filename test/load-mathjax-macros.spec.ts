import { strict as assert } from "assert";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  canonicalMathJaxMacrosPath,
  loadCanonicalMathJaxMacros,
  loadCanonicalTexMacroCommands,
  loadMathJaxMacros,
} from "source/app/util/load-mathjax-macros";

const VALID = "test/fixtures/mathjax-macros.json";
const MALFORMED = "test/fixtures/mathjax-macros.malformed.json";

describe("loadMathJaxMacros()", function () {
  it("parses an explicit MathJax macro fixture into validated definitions", async function () {
    const macros = await loadMathJaxMacros(VALID);

    assert.strictEqual(macros.RR, "\\mathbb{R}");
    assert.deepStrictEqual(macros.qty, ["\\left( {#1} \\right)", 1]);
    assert.deepStrictEqual(macros.optpair, ["\\left\\langle {#2}, {#1} \\right\\rangle", 2, ""]);
  });

  it("treats an absent explicit fixture as an empty map", async function () {
    assert.deepStrictEqual(await loadMathJaxMacros("test/fixtures/does-not-exist.json"), {});
  });

  it("fails loudly on a malformed macro definition instead of dropping it", async function () {
    await assert.rejects(loadMathJaxMacros(MALFORMED), /broken/);
  });
});

describe("central ~/.pandoc MathJax projection", function () {
  it("resolves the one production macro projection under ~/.pandoc", function () {
    assert.strictEqual(
      canonicalMathJaxMacrosPath("/home/author"),
      "/home/author/.pandoc/templates/css/mathjax-macros.json",
    );
  });

  it("loads the central generated projection rather than an app-local copy", async function () {
    const home = await mkdtemp(path.join(os.tmpdir(), "zettlr-central-macros-"));
    const target = canonicalMathJaxMacrosPath(home);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(VALID, "utf8"), "utf8");

    const macros = await loadCanonicalMathJaxMacros(home);
    assert.strictEqual(macros.RR, "\\mathbb{R}");
    assert.deepStrictEqual(macros.qty, ["\\left( {#1} \\right)", 1]);
  });

  it("fails loudly when the central generated projection is absent", async function () {
    const home = await mkdtemp(path.join(os.tmpdir(), "zettlr-central-macros-missing-"));
    await assert.rejects(loadCanonicalMathJaxMacros(home), /central generated projection/);
  });
});

describe("central ~/.pandoc compiler macro vocabulary", function () {
  it("includes compiler-only declarations recursively from the canonical macro tree", async function () {
    const home = await mkdtemp(path.join(os.tmpdir(), "zettlr-central-tex-macros-"));
    const root = path.join(home, ".pandoc", "styles", "macros");
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(
      path.join(root, "operators.sty"),
      "% \\newcommand{\\CommentedOut}{wrong}\n\\DeclareMathOperator{\\Spec}{Spec}\n\\newcommand{\\CompilerOnly}[1]{#1}\n\\DeclarePairedDelimiter\\qty{(}{)}\n\\NewDocumentCommand{\\xparseMacro}{m}{#1}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "nested", "aliases.tex"),
      "\\def\\ZZ{\\mathbb{Z}}\n\\let\\Alias=\\ZZ\n",
      "utf8",
    );
    await writeFile(path.join(root, "README.md"), "\\newcommand{\\NotTex}{x}\n", "utf8");

    assert.deepStrictEqual(
      new Set(await loadCanonicalTexMacroCommands(home)),
      new Set(["\\Alias", "\\CompilerOnly", "\\Spec", "\\ZZ", "\\qty", "\\xparseMacro"]),
    );
  });

  it("fails loudly when the canonical authoring macro tree is absent", async function () {
    const home = await mkdtemp(path.join(os.tmpdir(), "zettlr-central-tex-macros-missing-"));
    await assert.rejects(loadCanonicalTexMacroCommands(home), /canonical authoring macro tree/);
  });
});

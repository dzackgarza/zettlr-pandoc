import { strict as assert } from "node:assert";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { rm } from "fs/promises";
import { collectTexContext, type TexDocument, texDocument } from "source/common/util/tex-context";
import type { TexstudioCommandIndex } from "source/types/common/tex-vocabulary";
import { flowmarkTexVocabulary } from "./flowmark-tex-vocabulary-fixture";

const bs = String.fromCharCode(92);
const tick = String.fromCharCode(96);
const markdown = markdownParser({ zknLinkParserConfig: { format: "link|title" } }).language.parser;

/** A Markdown document with the metadata block of its syntax tree. */
function markdownDocument(source: string): TexDocument {
  return texDocument(source, "markdown", markdown.parse(source));
}

function latexDocument(source: string): TexDocument {
  return { kind: "latex", source };
}

describe("TeX package context", function () {
  this.timeout(60_000);

  let index: TexstudioCommandIndex;
  let home: string;

  before(async function () {
    const fixture = await flowmarkTexVocabulary("base.tex", "");
    index = fixture.vocabulary.index;
    home = fixture.home;
  });

  after(async function () {
    await rm(home, { recursive: true, force: true });
  });

  it("takes the packages of header-includes and raw TeX, and a class as its index entry", function () {
    const source = [
      "---",
      "header-includes:",
      "  - " + bs + "usepackage[foot]{mathtools, amsthm}",
      "---",
      "",
      bs + "documentclass{amsart}",
      bs + "documentclass{not-a-class}",
      bs + "RequirePackage{xcolor}",
      "$x+y$",
    ].join("\n");
    assert.deepEqual(collectTexContext(index, markdownDocument(source)).roots, [
      "amsthm",
      "class-amsart",
      "mathtools",
      "not-a-class",
      "xcolor",
    ]);
  });

  // Flowmark and Pandoc read no `tex:` key of the metadata block
  it("reads no tex key of the metadata block", function () {
    const source = ["---", "tex:", "  packages: [mathtools]", "---", "", "$x$"].join("\n");
    assert.deepEqual(collectTexContext(index, markdownDocument(source)).roots, []);
  });

  it("does not activate packages mentioned only in ordinary fenced or inline code", function () {
    const source = [
      "~~~tex",
      bs + "usepackage{mathtools}",
      "~~~",
      "inline code: " + tick + bs + "RequirePackage{xcolor}" + tick,
      "",
      "~~~{=latex}",
      bs + "usepackage{amsthm}",
      "~~~",
      tick + bs + "RequirePackage{graphicx}" + tick + "{=latex}",
    ].join("\n");
    assert.deepEqual(collectTexContext(index, markdownDocument(source)).roots, [
      "amsthm",
      "graphicx",
    ]);
  });

  it("does not close ordinary fences on fence-like content with trailing text", function () {
    const source = [
      "~~~tex",
      "~~~still code",
      bs + "usepackage{mathtools}",
      "~~~",
      bs + "usepackage{xcolor}",
    ].join("\n");
    assert.deepEqual(collectTexContext(index, markdownDocument(source)).roots, ["xcolor"]);
  });

  it("takes the commands that the TeX of the document defines", function () {
    const source = [
      bs + "newcommand{" + bs + "RR}{" + bs + "mathbb{R}}",
      bs + "DeclareMathOperator{" + bs + "Pic}{Pic}",
      bs + "def" + bs + "Spec{Spec}",
    ].join("\n");
    assert.deepEqual(collectTexContext(index, latexDocument(source)).userCommands, [
      bs + "Pic",
      bs + "RR",
      bs + "Spec",
    ]);
  });

  it("ignores commented package requirements", function () {
    const source = [
      "% " + bs + "usepackage{mathtools}",
      bs + "usepackage{xcolor} % " + bs + "RequirePackage{amsthm}",
    ].join("\n");
    assert.deepEqual(collectTexContext(index, latexDocument(source)).roots, ["xcolor"]);
  });
});

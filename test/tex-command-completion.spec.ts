import { strict as assert } from "node:assert";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { rm } from "fs/promises";
import {
  phraseCompletionSource,
  phraseCompletionsField,
} from "source/common/modules/markdown-editor/autocomplete/phrases";
import {
  texCommandCompletionSource,
  texDocumentKind,
  texVocabularyField,
} from "source/common/modules/markdown-editor/autocomplete/tex";
import type { TexCommandVocabulary } from "source/types/common/tex-vocabulary";
import { flowmarkTexVocabulary } from "./flowmark-tex-vocabulary-fixture";

const bs = String.fromCharCode(92);

function stateFor(
  doc: string,
  vocabulary: TexCommandVocabulary | null,
  kind: "markdown" | "latex" | "yaml" = "markdown",
): EditorState {
  const extensions = [texDocumentKind.of(kind), texVocabularyField.init(() => vocabulary)];
  if (kind === "markdown") {
    extensions.push(markdownParser({ zknLinkParserConfig: { format: "link|title" } }));
  }
  return EditorState.create({ doc, extensions });
}

async function completionFor(
  state: EditorState,
  pos = state.doc.length,
  explicit = true,
): Promise<CompletionResult | null> {
  return await texCommandCompletionSource(new CompletionContext(state, pos, explicit));
}

function optionLabels(result: CompletionResult | null): string[] {
  return result?.options.map((option) => option.label) ?? [];
}

describe("package-aware TeX command completion", function () {
  this.timeout(60_000);

  // A central macro tree that loads no package, and one that loads mathtools
  let bare: TexCommandVocabulary;
  let withMathtools: TexCommandVocabulary;
  const homes: string[] = [];

  before(async function () {
    for (const [file, text] of [
      ["base.tex", bs + "newcommand{" + bs + "ZZ}{x}\n"],
      ["base.sty", bs + "RequirePackage{mathtools}\n"],
    ]) {
      const fixture = await flowmarkTexVocabulary(file, text);
      homes.push(fixture.home);
      if (file === "base.tex") {
        bare = fixture.vocabulary;
      } else {
        withMathtools = fixture.vocabulary;
      }
    }
  });

  after(async function () {
    for (const home of homes) {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("offers no TeX command before the window has the vocabulary of Flowmark", async function () {
    assert.equal(await completionFor(stateFor("$" + bs + "xma", null)), null);
  });

  it("offers the commands of the packages that the central macro tree loads", async function () {
    const doc = "$" + bs + "xma";
    assert.ok(!optionLabels(await completionFor(stateFor(doc, bare))).includes(bs + "xmapsto"));
    const option = (await completionFor(stateFor(doc, withMathtools)))?.options.find(
      (candidate) => candidate.label === bs + "xmapsto",
    );
    assert.equal(option?.detail, "[mathtools]");
  });

  it("activates mathtools and its amsmath/amsopn closure from header-includes", async function () {
    const doc = [
      "---",
      "header-includes:",
      "  - " + bs + "usepackage{mathtools}",
      "---",
      "",
      "$" + bs + "xma",
    ].join("\n");
    const result = await completionFor(stateFor(doc, bare));
    const labels = optionLabels(result);
    assert.ok(labels.includes(bs + "xmapsto"));
    assert.ok(labels.includes(bs + "operatorname"));
    assert.equal(result?.from, doc.lastIndexOf(bs));
  });

  it("offers the commands of the class entry of a document class", async function () {
    const doc = [bs + "documentclass{amsart}", bs + "MRh"].join("\n");
    assert.ok(
      optionLabels(await completionFor(stateFor(doc, bare, "latex"))).includes(bs + "MRhref"),
    );
    assert.ok(
      !optionLabels(await completionFor(stateFor(bs + "MRh", bare, "latex"))).includes(
        bs + "MRhref",
      ),
    );
  });

  it("offers commands in raw TeX but never in ordinary code examples", async function () {
    const ordinary = ["~~~tex", bs + "usepackage{mathtools}", bs + "xma", "~~~"].join("\n");
    const ordinaryPos = ordinary.indexOf(bs + "xma") + 4;
    assert.equal(await completionFor(stateFor(ordinary, bare), ordinaryPos), null);

    const raw = ["~~~{=latex}", bs + "usepackage{mathtools}", bs + "xma", "~~~"].join("\n");
    const rawPos = raw.indexOf(bs + "xma") + 4;
    assert.ok(
      optionLabels(await completionFor(stateFor(raw, bare), rawPos)).includes(bs + "xmapsto"),
    );
  });

  // Pandoc reads TeX from header-includes only; another key of the block is a string
  it("reads only header-includes of the metadata block", async function () {
    const doc = [
      "---",
      "title: " + bs + "xma",
      "header-includes:",
      "  - " + bs + "usepackage{mathtools}",
      "---",
      "",
      "$" + bs + "xma",
    ].join("\n");
    const titlePos = doc.indexOf(bs + "xma") + 4;
    assert.equal(await completionFor(stateFor(doc, bare), titlePos), null);
    assert.ok(optionLabels(await completionFor(stateFor(doc, bare))).includes(bs + "xmapsto"));
  });

  it("works in LaTeX documents and Pandoc YAML header-includes", async function () {
    const latex = [bs + "usepackage{mathtools}", bs + "xma"].join("\n");
    assert.ok(
      optionLabels(await completionFor(stateFor(latex, bare, "latex"))).includes(bs + "xmapsto"),
    );

    const yaml = [
      "header-includes:",
      "  - " + bs + "usepackage{mathtools}",
      "  - " + bs + "xma",
    ].join("\n");
    assert.ok(
      optionLabels(await completionFor(stateFor(yaml, bare, "yaml"))).includes(bs + "xmapsto"),
    );
  });

  it("does not interpret unrelated YAML or frontmatter strings as TeX", async function () {
    const yaml = [
      "windows-path: C:" + bs + "Users" + bs + "notes",
      "other: " + bs + "xma",
      "header-includes:",
      "  - " + bs + "usepackage{mathtools}",
      "  - " + bs + "xma",
    ].join("\n");
    const otherPos = yaml.indexOf("other: ") + "other: ".length + 4;
    const headerPos = yaml.lastIndexOf(bs + "xma") + 4;
    assert.equal(await completionFor(stateFor(yaml, bare, "yaml"), otherPos), null);
    assert.ok(
      optionLabels(await completionFor(stateFor(yaml, bare, "yaml"), headerPos)).includes(
        bs + "xmapsto",
      ),
    );
  });

  it("does not interpret path fragments as raw TeX commands in Markdown", async function () {
    const doc = "Windows path C:" + bs + "Users" + bs + "notes and prose.";
    const pos = doc.indexOf(bs + "Users") + 4;
    assert.equal(await completionFor(stateFor(doc, bare), pos), null);
  });

  // The declaration forms of the central macro tree, without braces around the name (#203)
  it("offers each macro that the document declares, in each declaration form", async function () {
    const doc = [
      bs + "newcommand" + bs + "Restriction[2]{" + bs + "mathrm{Res}^{#1}_{#2}}",
      bs + "renewcommand*" + bs + "Rring{" + bs + "mathbb{R}}",
      bs + "DeclareMathOperator" + bs + "Rank{rank}",
      bs + "DeclarePairedDelimiter" + bs + "Rabs{" + bs + "lvert}{" + bs + "rvert}",
      bs + "NewDocumentCommand" + bs + "Rset{m}{" + bs + "{#1" + bs + "}}",
      bs + "newcommand{" + bs + "Rbraced}{x}",
      bs + "R",
    ].join("\n");
    const userMacros = (await completionFor(stateFor(doc, bare, "latex")))?.options
      .filter((option) => option.detail === "[user macro]")
      .map((option) => option.label)
      .sort();
    assert.deepEqual(
      userMacros,
      ["Rabs", "Rank", "Rbraced", "Restriction", "Rring", "Rset"].map((name) => bs + name),
    );
  });

  it("keeps prose dictionaries out of backslash command contexts", async function () {
    const phraseState = EditorState.create({
      doc: bs + "Sm",
      extensions: [
        markdownParser({ zknLinkParserConfig: { format: "link|title" } }),
        phraseCompletionsField.init(() => [{ text: "Smith-Minkowski-Siegel", source: "math.txt" }]),
      ],
    });
    const phraseResult = await phraseCompletionSource(
      new CompletionContext(phraseState, phraseState.doc.length, true),
    );
    assert.equal(phraseResult, null);
  });
});

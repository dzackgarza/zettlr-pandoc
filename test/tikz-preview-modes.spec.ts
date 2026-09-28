import { strict as assert } from "node:assert";
import { EditorState } from "@codemirror/state";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { activeTikzBlock } from "source/common/modules/markdown-editor/tikz-block";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import type { TikzLivePreviewTarget } from "tikz-workbench/src/live-preview";
import {
  defaultTikzPreviewMode,
  TIKZ_PREVIEW_MODES,
} from "tikz-workbench/src/preview-modes";
import { contiguousSourceLineRanges } from "tikz-workbench/src/source-block";

function target(source: string, language: "tikz" | "tikzcd"): TikzLivePreviewTarget {
  return {
    from: 0,
    to: source.length,
    sourceFrom: 0,
    sourceTo: source.length,
    source,
    authoredSource: source,
    sourceLineRanges: contiguousSourceLineRanges(source, 0),
    kind: "raw",
    language,
    docPath: "/notes/diagram.md",
  };
}

function nestedTarget(source: string, language: "tikz" | "tikzcd"): TikzLivePreviewTarget {
  const result = target(source, language);
  result.authoredSource = source.split("\n").join("\n  ");
  result.to = result.authoredSource.length;
  result.sourceTo = result.authoredSource.length;
  result.sourceLineRanges = result.sourceLineRanges.map((range, index) =>
    index === 0 ? range : { from: range.from + 2 * index, to: range.to + 2 * index },
  );
  return result;
}

describe("TikZ preview mode capabilities", function () {
  const visual = TIKZ_PREVIEW_MODES.find((mode) => mode.id === "visual");
  const quiver = TIKZ_PREVIEW_MODES.find((mode) => mode.id === "quiver");

  it("defaults tikzcd to Quiver and ordinary TikZ to the compiler", function () {
    assert.strictEqual(defaultTikzPreviewMode(target("A \\arrow[r] & B", "tikzcd")), "quiver");
    assert.strictEqual(
      defaultTikzPreviewMode(target("\\begin{tikzpicture}\n\\end{tikzpicture}", "tikz")),
      "tikz",
    );
  });

  it("offers the visual mode only for an authored tikzpicture environment", function () {
    assert.ok(visual !== undefined);
    assert.strictEqual(
      visual.supports(
        target("\\begin{tikzpicture}\n\\node (a) at (0,0) {A};\n\\end{tikzpicture}", "tikz"),
      ),
      true,
    );
    // A .tikz file: style setup before the environment, a comment after it.
    assert.strictEqual(
      visual.supports(
        target(
          "\\tikzset{every node/.style={draw}}\n\\begin{tikzpicture}\n\\node (a) at (0,0) {A};\n\\end{tikzpicture}\n% from figure 3",
          "tikz",
        ),
      ),
      true,
    );
    assert.strictEqual(visual.supports(target("\\draw (0,0) -- (1,1);", "tikz")), false);
    assert.strictEqual(visual.supports(target("\\input{figures/a.tikz}", "tikz")), false);
    assert.strictEqual(
      visual.supports(target("\\begin{tikzcd}\nA & B\n\\end{tikzcd}", "tikzcd")),
      false,
    );
  });

  it("keeps Quiver exclusive to tikzcd", function () {
    assert.ok(quiver !== undefined);
    assert.strictEqual(
      quiver.supports(target("\\begin{tikzcd}\nA & B\n\\end{tikzcd}", "tikzcd")),
      true,
    );
    assert.strictEqual(
      quiver.supports(target("\\begin{tikzpicture}\n\\end{tikzpicture}", "tikz")),
      false,
    );
  });

  it("offers Quiver for an indented tikzcd block", function () {
    const doc = [
      "",
      " \\begin{tikzcd}",
      '  X \\arrow[r, "f"] & Y \\\\',
      "  P & Q",
      "  \\end{tikzcd}",
      "",
    ].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("\\arrow") },
      extensions: [markdownParser(), configField],
    });
    const block = activeTikzBlock(state);
    assert.ok(block, "the editor recognizes the diagram");
    assert.equal(block.language, "tikzcd");
    assert.equal(quiver?.supports({ ...block, authoredSource: doc.slice(block.sourceFrom, block.sourceTo), docPath: "/notes/diagram.md" }), true);
  });

  it("offers Quiver for a tikzcd block inside a Markdown list", function () {
    const doc = [
      "- Diagram:",
      "",
      "  \\begin{tikzcd}",
      "  X \\arrow[r] & Y",
      "  \\end{tikzcd}",
      "",
      "- Next item",
    ].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("\\arrow") },
      extensions: [markdownParser(), configField],
    });
    const block = activeTikzBlock(state);
    assert.ok(block);
    assert.equal(quiver?.supports({ ...block, authoredSource: doc.slice(block.sourceFrom, block.sourceTo), docPath: "/notes/diagram.md" }), true);
  });

  it("gives an explicit reason when a provider cannot edit the source", function () {
    const diagram = target("\\begin{tikzcd}\nA & B\n\\end{tikzcd}", "tikzcd");
    assert.equal(visual?.supports(diagram), false);
    assert.match(visual?.unavailableTitle(diagram) ?? "", /tikzpicture/u);
    const picture = target("\\begin{tikzpicture}\n\\end{tikzpicture}", "tikz");
    assert.equal(quiver?.supports(picture), false);
    assert.match(quiver?.unavailableTitle(picture) ?? "", /tikzcd/u);
  });

  it("uses Quiver for uniform Markdown prefixes and keeps other editors restricted", function () {
    const tikzcd = nestedTarget("\\begin{tikzcd}\nA & B\n\\end{tikzcd}", "tikzcd");
    const tikz = nestedTarget(
      "\\begin{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}",
      "tikz",
    );
    assert.strictEqual(defaultTikzPreviewMode(tikzcd), "quiver");
    assert.strictEqual(quiver?.supports(tikzcd), true);
    assert.strictEqual(visual?.supports(tikz), false);
  });

  it("keeps a recognized tikzcd in Quiver when its source cannot be written back", function () {
    const source = "\\begin{tikzcd}\nX & Y\n\\end{tikzcd}";
    const mixed = nestedTarget(source, "tikzcd");
    mixed.authoredSource = mixed.authoredSource.replace("\n  \\end", "\n> \\end");
    assert.equal(defaultTikzPreviewMode(mixed), "quiver");
    assert.equal(quiver?.supports(mixed), false);
    assert.match(quiver?.unavailableTitle(mixed) ?? "", /Diagram line 3 uses Markdown prefix "> "; the preceding diagram lines use "  "/u);
  });
});

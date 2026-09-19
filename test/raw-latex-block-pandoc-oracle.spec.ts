/** Differential oracle for editor-side Pandoc RawBlock(tex) structure. */

import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { markdownToAST } from "source/common/modules/markdown-utils";
import type { ASTNode } from "source/common/modules/markdown-utils/markdown-ast";

const PANDOC_READER = [
  "markdown",
  "+fenced_divs",
  "+raw_tex",
  "+tex_math_dollars",
  "+tex_math_single_backslash",
  "+wikilinks_title_after_pipe",
].join("");

function childrenOf(node: ASTNode): ASTNode[] {
  if ("children" in node) {
    return node.children;
  }
  if ("items" in node) {
    return node.items;
  }
  if ("rows" in node) {
    return node.rows;
  }
  if ("cells" in node) {
    return node.cells;
  }
  return [];
}

function editorRawBlocks(source: string): string[] {
  const blocks: string[] = [];
  const visit = (node: ASTNode): void => {
    if (node.type === "RawBlock" && node.format === "tex") {
      blocks.push(node.source);
    }
    for (const child of childrenOf(node)) {
      visit(child);
    }
  };
  visit(markdownToAST(source));
  return blocks;
}

function pandocRawBlocks(source: string): string[] {
  const raw = execFileSync("pandoc", ["-f", PANDOC_READER, "-t", "json"], {
    input: source,
    encoding: "utf-8",
  });
  const document = JSON.parse(raw) as unknown;
  const blocks: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.t === "RawBlock" &&
      Array.isArray(record.c) &&
      record.c[0] === "tex" &&
      typeof record.c[1] === "string"
    ) {
      blocks.push(record.c[1]);
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(document);
  return blocks;
}

const cases = [
  {
    name: "blank lines inside a tikzpicture",
    source:
      "Before.\n\n\\begin{tikzpicture}\n\n\\draw (0,0)--(1,1);\n\n\\end{tikzpicture}\n\nAfter.\n",
  },
  {
    name: "raw block immediately after prose",
    source: "Before.\n\\begin{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}\nAfter.\n",
  },
  {
    name: "tikzpicture inside a fenced div",
    source:
      "::: {.example}\nBefore.\n\n\\begin{tikzpicture}\n\n\\draw (0,0)--(1,1);\n\n\\end{tikzpicture}\n\nAfter.\n:::\n",
  },
  {
    name: "generic tabular raw block",
    source: "Before.\n\n\\begin{tabular}{cc}\na & b\\\\\nc & d\n\\end{tabular}\n\nAfter.\n",
  },
  {
    name: "generic figure raw block with an internal blank line",
    source: "Before.\n\n\\begin{figure}\nhello\n\nworld\n\\end{figure}\n\nAfter.\n",
  },
  {
    name: "raw block inside a blockquote",
    source:
      "> Before.\n>\n> \\begin{tikzpicture}\n>   \\draw (0,0)--(1,1);\n> \\end{tikzpicture}\n",
  },
  {
    name: "raw block inside a list item",
    source: "- Before.\n\n  \\begin{tikzpicture}\n    \\draw (0,0)--(1,1);\n  \\end{tikzpicture}\n",
  },
  {
    name: "same-name nesting",
    source: "\\begin{figure}\n\\begin{figure}\nx\n\\end{figure}\n\\end{figure}\n",
  },
  {
    name: "commented fake closing environment",
    source:
      "\\begin{tikzpicture}\n% \\end{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}\n",
  },
  {
    name: "trailing Markdown after the closing environment",
    source: "\\begin{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture} trailing\n",
  },
  {
    name: "standalone input command",
    source: "\\input{figures/example.tikz}\n",
  },
  {
    name: "input command with trailing Markdown",
    source: "\\input{figures/example.tikz} trailing\n",
  },
  {
    name: "usepackage command with options",
    source: "\\usepackage[calc,shapes.geometric]{tikz}\n",
  },
  {
    name: "standalone page-break command",
    source: "\\newpage\n",
  },
  {
    name: "section command with trailing Markdown",
    source: "\\section{Title} trailing\n",
  },
  {
    name: "multiline macro definition",
    source: "\\newcommand{\\foo}{%\n  alpha\n  beta\n}\n",
  },
  {
    name: "classic def macro",
    source: "\\def\\foo#1{value #1}\n",
  },
  {
    name: "inline-only raw TeX command remains outside RawBlock",
    source: "\\includegraphics{figure.pdf}\n",
  },
  {
    name: "display-math environment remains math rather than RawBlock",
    source: "Before.\n\n\\begin{align}\na &= b \\\\ \nc &= d\n\\end{align}\n\nAfter.\n",
  },
] as const;

describe("Pandoc raw-LaTeX block differential oracle", function () {
  this.timeout(30000);

  it("has a working Pandoc oracle", function () {
    assert.match(execFileSync("pandoc", ["--version"], { encoding: "utf-8" }), /^pandoc \d+/);
  });

  for (const testCase of cases) {
    it(`matches Pandoc for ${testCase.name}`, function () {
      assert.deepEqual(editorRawBlocks(testCase.source), pandocRawBlocks(testCase.source));
    });
  }
});

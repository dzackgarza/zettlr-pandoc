import { strict as assert } from "node:assert";
import "./provision-renderer-window-seams";
import {
  type Completion,
  CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { buildMathJaxCompletionCatalogue } from "@common/util/mathtex-to-html";
import {
  __resetProseCompletionCacheForTests,
  proseDictionarySource,
} from "source/common/modules/markdown-editor/autocomplete/prose-dictionary";
import {
  __resetTikzTemplateCompletionCacheForTests,
  texCommandSource,
} from "source/common/modules/markdown-editor/autocomplete/tex-commands";
import {
  __texConstructionsForTests,
  texConstructionSource,
} from "source/common/modules/markdown-editor/autocomplete/tex-constructions";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";

function contextFor(doc: string, pos = doc.length): CompletionContext {
  return new CompletionContext(
    EditorState.create({ doc, selection: { anchor: pos }, extensions: [markdownParser()] }),
    pos,
    false,
  );
}

interface SourcedCompletion extends Completion {
  zettlrSource?: string;
}

function sourceOf(completion: Completion): string | undefined {
  return (completion as SourcedCompletion).zettlrSource;
}

function installFakeInvoke(
  handler: (channel: string, message?: unknown) => Promise<unknown>,
): void {
  window.ipc.invoke = handler as typeof window.ipc.invoke;
}

async function resolveSource(
  source: typeof texCommandSource,
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  return await source(ctx);
}

describe("LaTeX/TikZ completion sources", function () {
  let originalInvoke: typeof window.ipc.invoke;

  beforeEach(function () {
    originalInvoke = window.ipc.invoke;
    __resetTikzTemplateCompletionCacheForTests();
    installFakeInvoke(async (channel: string) => {
      if (channel === "tikz-completion-commands") {
        return [
          { label: "\\QHS", argumentCount: 1, declaration: "\\newcommand{\\QHS}[1]{#1}" },
          { label: "\\tikzfig", argumentCount: 2, declaration: "\\newcommand{\\tikzfig}[2]{#1#2}" },
          {
            label: "\\includegraphics",
            argumentCount: 2,
            declaration: "\\renewcommand{\\includegraphics}[2]{#1#2}",
          },
        ];
      }
      if (channel === "mathjax-macros") {
        return {
          ZZ: "\\mathbb{Z}",
          fracId: "\\operatorname{fracId}",
          fractional: "\\operatorname{fractional}",
          fractionalpart: "\\operatorname{fractionalpart}",
          pair: ["#1\\otimes#2", 2] as const,
          optpair: ["#1:#2", 2, "left"] as const,
        };
      }
      if (channel === "tex-macro-commands") {
        return ["\\CompilerOnly"];
      }
      throw new Error(`unexpected IPC ${channel}`);
    });
  });

  afterEach(function () {
    window.ipc.invoke = originalInvoke;
  });

  it("derives custom MathJax macros from the exact parser configuration", function () {
    const catalogue = buildMathJaxCompletionCatalogue({ ZZ: "\\mathbb{Z}" });
    assert.ok(catalogue.commands.includes("\\ZZ"));
    assert.ok(catalogue.commands.includes("\\alpha"));
  });

  it("offers the maintained LaTeX Workshop catalogue in Markdown math", async function () {
    const doc = "$\\fra$";
    const result = await resolveSource(texCommandSource, contextFor(doc, doc.length - 1));
    assert.ok(result !== null);
    assert.ok(result.options.some((option) => option.label === "\\frac"));
  });

  it("ranks user macros above stock LaTeX commands sharing their prefix", async function () {
    const doc = "$\\fr$";
    const result = await resolveSource(texCommandSource, contextFor(doc, doc.length - 1));
    assert.ok(result !== null);
    const stock = result.options.find(
      (option) => option.label === "\\frac" && sourceOf(option) === "LaTeX",
    );
    const macro = result.options.find(
      (option) => option.label === "\\fracId" && sourceOf(option) === "Macro",
    );
    assert.ok(stock !== undefined);
    assert.ok(macro !== undefined);
    assert.ok((macro.boost ?? 0) > (stock.boost ?? 0));
  });

  it("keeps a user TikZ-template macro visible when it shadows a stock command", async function () {
    const doc = "\\begin{tikzpicture}\n\\incl\n\\end{tikzpicture}";
    const pos = doc.indexOf("\\incl") + "\\incl".length;
    const result = await resolveSource(texCommandSource, contextFor(doc, pos));
    assert.ok(result !== null);
    const overlapping = result.options.filter((option) => option.label === "\\includegraphics");
    const stock = overlapping.find((option) => sourceOf(option) === "LaTeX");
    const macro = overlapping.find((option) => sourceOf(option) === "Macro");
    assert.ok(stock !== undefined);
    assert.ok(macro !== undefined);
    assert.ok((macro.boost ?? 0) > (stock.boost ?? 0));
  });

  it("offers user-owned MathJax macros in Markdown math", async function () {
    const doc = "$\\Z$";
    const result = await resolveSource(texCommandSource, contextFor(doc, doc.length - 1));
    const macro = result?.options.find((option) => option.label === "\\ZZ");
    assert.ok(macro !== undefined);
    assert.equal((macro as typeof macro & { zettlrSource?: string }).zettlrSource, "Macro");
    assert.equal(macro.detail, "user macro");
    assert.equal(typeof macro.info, "function");
    const info = (macro.info as (completion: typeof macro) => Node)(macro);
    assert.match(info.textContent ?? "", /\\ZZ → \\mathbb\{Z\}/u);
  });

  it("offers compiler-only canonical macros even when MathJax cannot project them", async function () {
    const doc = "$\\Comp$";
    const result = await resolveSource(texCommandSource, contextFor(doc, doc.length - 1));
    const macro = result?.options.find((option) => option.label === "\\CompilerOnly");
    assert.ok(macro !== undefined);
    assert.equal((macro as typeof macro & { zettlrSource?: string }).zettlrSource, "Macro");
    assert.equal(macro.detail, "compiler macro");
  });

  it("turns canonical macros with arguments into snippet-like completions", async function () {
    const doc = "$\\pa$";
    const result = await resolveSource(texCommandSource, contextFor(doc, doc.length - 1));
    const macro = result?.options.find((option) => option.label === "\\pair");
    assert.ok(macro !== undefined);
    assert.equal(macro.detail, "user macro · 2 args");
    assert.equal(typeof macro.apply, "function");
    assert.equal(typeof macro.info, "function");
    const info = (macro.info as (completion: typeof macro) => Node)(macro);
    assert.match(info.textContent ?? "", /\\pair → #1\\otimes#2/u);
    assert.match(info.textContent ?? "", /\\pair\{\$\{1\}\}\{\$\{2\}\}/u);
  });

  it("offers ordinary LaTeX, TikZ grammar commands, and template-owned macros inside TikZ", async function () {
    for (const [typed, expected] of [
      ["\\incl", "\\includegraphics"],
      ["\\dra", "\\draw"],
      ["\\QH", "\\QHS"],
    ] as const) {
      const doc = `\\begin{tikzpicture}\n${typed}\n\\end{tikzpicture}`;
      const pos = doc.indexOf(typed) + typed.length;
      const result = await resolveSource(texCommandSource, contextFor(doc, pos));
      assert.ok(result !== null, `${typed} should activate completion`);
      assert.ok(
        result.options.some((option) => option.label === expected),
        `${expected} missing from ${typed} completion`,
      );
    }

    const doc = "\\begin{tikzpicture}\n\\QH\n\\end{tikzpicture}";
    const pos = doc.indexOf("\\QH") + 3;
    const result = await resolveSource(texCommandSource, contextFor(doc, pos));
    const macro = result?.options.find((option) => option.label === "\\QHS");
    assert.ok(macro !== undefined);
    assert.equal((macro as typeof macro & { zettlrSource?: string }).zettlrSource, "Macro");
    assert.equal(macro.detail, "TikZ template macro · 1 arg");
    assert.equal(typeof macro.info, "function");
    const info = (macro.info as (completion: typeof macro) => Node)(macro);
    assert.match(info.textContent ?? "", /\\newcommand\{\\QHS\}\[1\]\{#1\}/u);
  });

  it("offers tikzcd commands and LaTeX commands together in tikzcd", async function () {
    const arrowDoc = "\\begin{tikzcd}\nA \\arr\n\\end{tikzcd}";
    const arrowPos = arrowDoc.indexOf("\\arr") + 4;
    const arrow = await resolveSource(texCommandSource, contextFor(arrowDoc, arrowPos));
    assert.ok(arrow !== null && arrow.options.some((option) => option.label === "\\arrow"));

    const fracDoc = "\\begin{tikzcd}\nA \\fra\n\\end{tikzcd}";
    const fracPos = fracDoc.indexOf("\\fra") + 4;
    const frac = await resolveSource(texCommandSource, contextFor(fracDoc, fracPos));
    assert.ok(frac !== null && frac.options.some((option) => option.label === "\\frac"));
  });

  it("completes ordinary LaTeX environments after \\begin{", async function () {
    const doc = "$\\begin{ite$";
    const pos = doc.length - 1;
    const result = await resolveSource(texCommandSource, contextFor(doc, pos));
    assert.ok(result !== null && result.options.some((option) => option.label === "itemize"));
  });

  it("does not spray LaTeX command completion into ordinary prose", async function () {
    assert.strictEqual(await resolveSource(texCommandSource, contextFor("Prose \\fra")), null);
  });
});

describe("LaTeX/TikZ construction snippets", function () {
  it("keeps a broad collision-free mnemonic catalogue", function () {
    const triggers = __texConstructionsForTests.flatMap((construction) => construction.triggers);
    assert.ok(
      triggers.length >= 60,
      `expected a broad construction catalogue, got ${triggers.length} triggers`,
    );
    const normalized = triggers.map((trigger) => trigger.toLocaleLowerCase());
    assert.equal(
      new Set(normalized).size,
      normalized.length,
      "construction triggers must be unique case-insensitively",
    );
  });

  it("offers documented matrix scaffolds in math", function () {
    const doc = "$bma$";
    const result = texConstructionSource(contextFor(doc, doc.length - 1));
    assert.ok(result !== null && !(result instanceof Promise));
    const bmat = result.options.find((option) => option.label === "bmat");
    assert.ok(bmat !== undefined);
    assert.equal((bmat as typeof bmat & { zettlrSource?: string }).zettlrSource, "LaTeX");
    assert.match(bmat.detail ?? "", /square brackets/u);
    assert.equal(typeof bmat.info, "function");
    const info = (bmat.info as (completion: typeof bmat) => Node)(bmat);
    assert.match(info.textContent ?? "", /\\begin\{bmatrix\}/u);
  });

  it("offers TikZ scaffolds only inside TikZ source", function () {
    const doc = "\\begin{tikzpicture}\nno\n\\end{tikzpicture}";
    const pos = doc.indexOf("no") + 2;
    const result = texConstructionSource(contextFor(doc, pos));
    assert.ok(result !== null && !(result instanceof Promise));
    const node = result.options.find((option) => option.label === "node");
    assert.ok(node !== undefined);
    assert.equal((node as typeof node & { zettlrSource?: string }).zettlrSource, "TikZ");
    assert.match(node.detail ?? "", /Named TikZ node/u);
    assert.strictEqual(texConstructionSource(contextFor("ordinary bma")), null);
  });

  it("offers the common derivative/delimiter and tikz-cd families", function () {
    const mathDoc = "$pde$";
    const math = texConstructionSource(contextFor(mathDoc, mathDoc.length - 1));
    assert.ok(math !== null && !(math instanceof Promise));
    assert.ok(math.options.some((option) => option.label === "pderiv"));

    const delimiterDoc = "$flo$";
    const delimiter = texConstructionSource(contextFor(delimiterDoc, delimiterDoc.length - 1));
    assert.ok(delimiter !== null && !(delimiter instanceof Promise));
    assert.ok(delimiter.options.some((option) => option.label === "floor"));

    const cdDoc = "\\begin{tikzcd}\nA bend\n\\end{tikzcd}";
    const cdPos = cdDoc.indexOf("bend") + 4;
    const cd = texConstructionSource(contextFor(cdDoc, cdPos));
    assert.ok(cd !== null && !(cd instanceof Promise));
    assert.ok(cd.options.some((option) => option.label === "bendleft"));
    assert.ok(cd.options.some((option) => option.label === "bendright"));
  });
});

describe("portable prose dictionary completion", function () {
  let originalInvoke: typeof window.ipc.invoke;

  beforeEach(function () {
    originalInvoke = window.ipc.invoke;
    __resetProseCompletionCacheForTests();
    installFakeInvoke(async (channel: string, message?: unknown) => {
      const command =
        typeof message === "object" && message !== null && "command" in message
          ? String(message.command)
          : undefined;
      if (channel === "dictionary-provider" && command === "get-prose-completions") {
        return ["therefore", "theorem", "on the other hand", "in particular"];
      }
      throw new Error(`unexpected IPC ${channel}:${String(command)}`);
    });
  });

  afterEach(function () {
    window.ipc.invoke = originalInvoke;
  });

  it("completes ordinary dictionary words", async function () {
    const result = await proseDictionarySource(contextFor("theref"));
    assert.ok(result !== null);
    const therefore = result.options.find((option) => option.label === "therefore");
    assert.ok(therefore !== undefined);
    assert.equal((therefore as typeof therefore & { zettlrSource?: string }).zettlrSource, "Prose");
    assert.equal(therefore.detail, "prose word");
  });

  it("completes a multi-word phrase from a partially typed phrase", async function () {
    const result = await proseDictionarySource(contextFor("on th"));
    assert.ok(result !== null);
    assert.strictEqual(result.from, 0);
    assert.ok(result.options.some((option) => option.label === "on the other hand"));
  });

  it("also offers phrase entries from their first word", async function () {
    const result = await proseDictionarySource(contextFor("in"));
    assert.ok(result !== null);
    assert.ok(result.options.some((option) => option.label === "in particular"));
  });

  it("does not offer prose dictionary entries inside math, code, or TikZ", async function () {
    const math = "$theref$";
    assert.strictEqual(await proseDictionarySource(contextFor(math, math.length - 1)), null);

    const code = "`theref`";
    assert.strictEqual(await proseDictionarySource(contextFor(code, code.length - 1)), null);

    const tikz = "\\begin{tikzpicture}\ntheref\n\\end{tikzpicture}";
    const tikzPos = tikz.indexOf("theref") + "theref".length;
    assert.strictEqual(await proseDictionarySource(contextFor(tikz, tikzPos)), null);
  });
});

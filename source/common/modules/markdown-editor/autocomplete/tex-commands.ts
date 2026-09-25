/**
 * LaTeX/TikZ control-word completion.
 *
 * Standard LaTeX command/snippet data comes from the maintained MIT-licensed
 * LaTeX Workshop catalogue under static/autocomplete. User MathJax macros are
 * merged from the exact parser initialized by this renderer. TikZ command
 * names are generated from the installed @tikz-editor grammar.
 */
import {
  type Completion,
  type CompletionResult,
  type CompletionSource,
  snippet as codeMirrorSnippet,
  startCompletion,
} from "@codemirror/autocomplete";
import type { MathJaxMacro } from "@common/util/mathjax-config";
import { mathJaxCompletionCatalogue } from "@common/util/mathtex-to-html";
import { standardTexControlWords } from "@common/util/standard-tex-control-words";
import latexWorkshopCommands from "../../../../../static/autocomplete/latex-workshop-commands.json";
import latexWorkshopEnvironments from "../../../../../static/autocomplete/latex-workshop-environments.json";
import { tikzBlockAt } from "../tikz-block";
import { isMathPosition } from "../util/is-math-position";
import {
  completionInfoPanel,
  withCompletionSource,
  withDefaultCompletionInfo,
} from "./completion-presentation";
import { TIKZ_CONTROL_WORDS } from "./generated-tikz-commands";
import { codeMirrorTemplateForSnippet } from "./snippets";

interface LatexWorkshopEntry {
  snippet?: string;
  detail?: string;
  documentation?: string;
  postAction?: string;
}

interface LatexWorkshopEnvironment {
  name: string;
  /**
   * Present when LaTeX Workshop supplies a snippet. A non-empty `format`
   * means the snippet is the environment's argument group; an empty one means
   * the snippet is the environment's body.
   */
  arg?: {
    format: string;
    snippet: string;
  };
}

const TIKZCD_CONTROL_WORDS = ["\\arrow", "\\ar"] as const;
interface TikzTemplateCompletion {
  label: string;
  argumentCount?: number;
  declaration?: string;
  sourceFile?: string;
}

let tikzTemplateCommandPromise: Promise<readonly TikzTemplateCompletion[]> | null = null;
interface UserMathJaxCommand {
  label: string;
  definition: MathJaxMacro;
}

let userMathJaxCommandPromise: Promise<readonly UserMathJaxCommand[]> | null = null;
let compilerTexCommandPromise: Promise<readonly string[]> | null = null;
let knownTexControlWordPromise: Promise<ReadonlySet<string>> | null = null;

async function tikzTemplateCommands(): Promise<readonly TikzTemplateCompletion[]> {
  if (tikzTemplateCommandPromise === null) {
    tikzTemplateCommandPromise = window.ipc.invoke("tikz-completion-commands");
  }
  return await tikzTemplateCommandPromise;
}

function argumentScaffold(label: string, argumentCount: number | undefined): string {
  if (argumentCount === undefined || argumentCount === 0) {
    return `${label}$0`;
  }
  return `${label}${Array.from({ length: argumentCount }, (_unused, index) => `{\${${index + 1}}}`).join("")}$0`;
}

async function userMathJaxCommands(): Promise<readonly UserMathJaxCommand[]> {
  if (userMathJaxCommandPromise === null) {
    userMathJaxCommandPromise = window.ipc.invoke("mathjax-macros").then((macros) =>
      Object.entries(macros).map(([name, definition]) => ({
        label: `\\${name}`,
        definition,
      })),
    );
  }
  return await userMathJaxCommandPromise;
}

async function compilerTexCommands(): Promise<readonly string[]> {
  if (compilerTexCommandPromise === null) {
    compilerTexCommandPromise = window.ipc.invoke("tex-macro-commands");
  }
  return await compilerTexCommandPromise;
}

function macroInfo(macro: UserMathJaxCommand): string {
  if (typeof macro.definition === "string") {
    return `User MathJax macro\n${macro.label} → ${macro.definition}`;
  }
  const [replacement, argumentCount, optionalDefault] = macro.definition;
  const signature =
    optionalDefault === undefined
      ? `${argumentCount} argument${argumentCount === 1 ? "" : "s"}`
      : `${argumentCount} arguments; optional default: ${optionalDefault}`;
  return `User MathJax macro · ${signature}\n${macro.label} → ${replacement}`;
}

function macroDetail(macro: UserMathJaxCommand): string {
  if (typeof macro.definition === "string") {
    return "user macro";
  }
  const [, argumentCount, optionalDefault] = macro.definition;
  if (optionalDefault !== undefined) {
    return `user macro · ${argumentCount} arg${argumentCount === 1 ? "" : "s"} · optional first`;
  }
  return `user macro · ${argumentCount} arg${argumentCount === 1 ? "" : "s"}`;
}

/** Build a navigable invocation from the canonical macro arity. */
function macroInvocationTemplate(macro: UserMathJaxCommand): string {
  if (typeof macro.definition === "string") {
    return `${macro.label}$0`;
  }
  const [, argumentCount, optionalDefault] = macro.definition;
  const fields: string[] = [];
  let next = 1;
  if (optionalDefault !== undefined) {
    fields.push(`[\${${next++}:optional}]`);
  }
  while (next <= argumentCount) {
    fields.push(`{\${${next++}}}`);
  }
  return `${macro.label}${fields.join("")}$0`;
}

/** Extract the authored control word from LaTeX Workshop keys such as frac{}{}. */
function commandName(key: string): string | null {
  const match = /^[A-Za-z@]+/u.exec(key);
  return match === null ? null : match[0];
}

function latexWorkshopOptions(): Completion[] {
  const options: Completion[] = [];
  for (const [key, untypedEntry] of Object.entries(latexWorkshopCommands)) {
    const name = commandName(key);
    if (name === null) {
      continue;
    }
    const entry = untypedEntry as LatexWorkshopEntry;
    const body = `\\${entry.snippet ?? key}`;
    options.push(
      withCompletionSource(
        {
          label: `\\${name}`,
          type: "keyword",
          detail: entry.detail,
          info: () =>
            completionInfoPanel({
              title: `\\${name}`,
              source: "LaTeX",
              description: entry.documentation ?? entry.detail,
              syntax: entry.detail,
              insertion: body,
            }),
          apply(view, completion, from, to) {
            const template = codeMirrorTemplateForSnippet(view.state, body);
            codeMirrorSnippet(template)(view, completion, from, to);
            if (entry.postAction === "editor.action.triggerSuggest") {
              queueMicrotask(() => {
                startCompletion(view);
              });
            }
          },
        },
        "LaTeX",
      ),
    );
  }
  return options;
}

const STANDARD_LATEX_OPTIONS = latexWorkshopOptions();

/** One description per environment in latex-workshop-environments.json. */
const ENVIRONMENT_DESCRIPTION: Record<string, string> = {
  document: "Body of a LaTeX document.",
  table: "Floating table with an optional caption.",
  math: "Inline mathematics.",
  displaymath: "Unnumbered display mathematics.",
  array: "Array of math cells with a column specification.",
  subarray: "Compact single-column array for stacked limits.",
  eqnarray: "Legacy numbered equation array with three columns.",
  subequations: "Equations numbered as subdivisions of one parent number.",
  "subequations*": "Starred subequations group.",
  multline: "Single numbered equation broken across lines.",
  "multline*": "Unnumbered single equation broken across lines.",
  "gather*": "Centered stack of unnumbered display equations.",
  alignedat: "Aligned block with explicit column pairs inside a display.",
  flalign: "Display equations aligned and spread to the full line width.",
  "flalign*": "Unnumbered equations aligned and spread to the full line width.",
  xalignat: "Aligned equation columns with expanded spacing.",
  "xalignat*": "Unnumbered aligned equation columns with expanded spacing.",
  definition: "LaTeX definition environment.",
  example: "LaTeX example environment.",
  remark: "LaTeX remark environment.",
  center: "Centered lines of text.",
  flushleft: "Left-aligned lines of text.",
  flushright: "Right-aligned lines of text.",
  minipage: "Box of given width containing paragraphs.",
  quotation: "Long quotation with paragraph indentation.",
  quote: "Short quotation.",
  verbatim: "Text typeset exactly as written.",
  verse: "Poetry with line breaks preserved.",
  picture: "LaTeX picture drawing environment.",
  tabbing: "Text aligned at tab stops.",
  tabular: "Table of cells with a column specification.",
  thebibliography: "Manually written bibliography list.",
  titlepage: "Title page without a page number.",
  matrix: "Matrix with no surrounding delimiters.",
  bmatrix: "Matrix delimited by square brackets [ ].",
  Bmatrix: "Matrix delimited by braces { }.",
  pmatrix: "Matrix delimited by parentheses ( ).",
  vmatrix: "Matrix/determinant delimited by single vertical bars | |.",
  Vmatrix: "Matrix delimited by double vertical bars ‖ ‖.",
  smallmatrix: "Compact matrix intended for inline mathematics.",
  cases: "Piecewise/case expression with a left brace.",
  aligned: "Aligned equations inside an existing math display.",
  align: "Display equations aligned at ampersand markers.",
  "align*": "Unnumbered display equations aligned at ampersand markers.",
  gathered: "Centered stack of equations inside an existing display.",
  gather: "Centered stack of display equations.",
  split: "Split a single equation across aligned lines.",
  equation: "Single numbered display equation.",
  "equation*": "Single unnumbered display equation.",
  itemize: "Bulleted list.",
  enumerate: "Numbered list.",
  description: "Description list with labeled items.",
  theorem: "LaTeX theorem environment.",
  lemma: "LaTeX lemma environment.",
  proposition: "LaTeX proposition environment.",
  corollary: "LaTeX corollary environment.",
  proof: "LaTeX proof environment.",
};

function environmentTemplateSource({ name, arg }: LatexWorkshopEnvironment): string {
  const begin = `\\begin{${name}}`;
  const end = `\n\\end{${name}}`;
  const emptyBody = "\n\t$0";
  if (arg === undefined) {
    return `${begin}${emptyBody}${end}`;
  }
  if (arg.format === "") {
    return `${begin}${arg.snippet}${end}`;
  }
  return `${begin}${arg.snippet}${emptyBody}${end}`;
}

function environmentDescription(name: string): string {
  const description: string | undefined = ENVIRONMENT_DESCRIPTION[name];
  if (description === undefined) {
    throw new Error(
      `LaTeX environment "${name}" from static/autocomplete/latex-workshop-environments.json ` +
        "has no ENVIRONMENT_DESCRIPTION entry in autocomplete/tex-commands.ts; add one.",
    );
  }
  return description;
}

function latexEnvironmentOptions(): Completion[] {
  return (latexWorkshopEnvironments as LatexWorkshopEnvironment[]).map((environment) =>
    withCompletionSource(
      {
        label: environment.name,
        type: "type",
        detail: environmentDescription(environment.name),
        info: () =>
          completionInfoPanel({
            title: environment.name,
            source: "LaTeX",
            description: environmentDescription(environment.name),
            insertion: environmentTemplateSource(environment),
          }),
        apply(view, completion, from, to) {
          // The completion is invoked after the already-authored `\\begin{`.
          // Preserve LaTeX Workshop's optional environment argument/body snippet,
          // and close the environment automatically. The existing snippet adapter
          // keeps placeholders native to CodeMirror.
          const completeTemplate = environmentTemplateSource(environment);
          const templateSource = completeTemplate.slice("\\begin{".length);
          const template = codeMirrorTemplateForSnippet(view.state, templateSource);
          codeMirrorSnippet(template)(view, completion, from, to);
        },
      },
      "LaTeX",
    ),
  );
}

const STANDARD_ENVIRONMENT_OPTIONS = latexEnvironmentOptions();

/**
 * Every TeX control word the editor's configured math environment knows about:
 * maintained LaTeX Workshop commands, commands exposed by the live MathJax
 * parser, and the user's canonical ~/.pandoc macro projection.
 *
 * This is intentionally shared with scholarly diagnostics so completion and
 * "unknown command" lint can never maintain competing vocabularies.
 */
export async function knownTexControlWords(): Promise<ReadonlySet<string>> {
  if (knownTexControlWordPromise === null) {
    knownTexControlWordPromise = (async () => {
      const commands = new Set(standardTexControlWords());
      for (const label of mathJaxCompletionCatalogue().commands) {
        commands.add(label);
      }
      for (const macro of await userMathJaxCommands()) {
        commands.add(macro.label);
      }
      for (const label of await compilerTexCommands()) {
        commands.add(label);
      }
      return commands;
    })();
  }
  return await knownTexControlWordPromise;
}

/** User-owned macro names from the canonical ~/.pandoc MathJax projection. */
export async function configuredMathMacroNames(): Promise<ReadonlySet<string>> {
  return new Set((await userMathJaxCommands()).map((macro) => macro.label));
}

/** Exact definitions from the canonical ~/.pandoc MathJax macro projection. */
export async function configuredMathMacros(): Promise<ReadonlyMap<string, MathJaxMacro>> {
  return new Map((await userMathJaxCommands()).map((macro) => [macro.label, macro.definition]));
}

async function commandOptions(inTikz: boolean, inTikzCd: boolean): Promise<Completion[]> {
  const options = [...STANDARD_LATEX_OPTIONS];
  // Keep a set only for commands which would otherwise be inserted as plain
  // text. LaTeX Workshop intentionally carries several useful snippet variants
  // with the same label; those remain separate completion rows.
  const standardLabels = new Set(STANDARD_LATEX_OPTIONS.map((option) => option.label));

  for (const label of mathJaxCompletionCatalogue().commands) {
    if (!standardLabels.has(label)) {
      const sourced = withCompletionSource(
        { label, type: "keyword", detail: "MathJax command", boost: 2 },
        "MathJax",
      );
      options.push(withDefaultCompletionInfo(sourced, "MathJax", label));
    }
  }
  for (const macro of await userMathJaxCommands()) {
    // The user's canonical macro projection is an independent semantic source.
    // Keep it visible even when its name overlaps a stock LaTeX command: the
    // [Macro] row documents the actual local expansion/arity and is boosted
    // above the generic catalogue row.
    if (
      !options.some(
        (option) =>
          option.label === macro.label && option.detail?.startsWith("user macro") === true,
      )
    ) {
      const invocation = macroInvocationTemplate(macro);
      options.push(
        withCompletionSource(
          {
            label: macro.label,
            type: "keyword",
            detail: macroDetail(macro),
            info: () =>
              completionInfoPanel({
                title: macro.label,
                source: "Macro",
                description: macroInfo(macro),
                syntax: "Canonical ~/.pandoc MathJax macro",
                insertion: invocation,
              }),
            // User-authored semantics outrank the stock catalogue. A family of
            // locally defined `\\frac...` macros is useful signal, not noise to be
            // pushed below the generic `\\frac` command.
            boost: 25,
            apply(view, completion, from, to) {
              codeMirrorSnippet(invocation)(view, completion, from, to);
            },
          },
          "Macro",
        ),
      );
    }
  }
  for (const label of await compilerTexCommands()) {
    if (!options.some((option) => option.label === label)) {
      const sourced = withCompletionSource(
        {
          label,
          type: "keyword",
          detail: "compiler macro",
          boost: 15,
        },
        "Macro",
      );
      options.push(withDefaultCompletionInfo(sourced, "Macro", label));
    }
  }
  if (inTikz) {
    for (const label of TIKZ_CONTROL_WORDS) {
      if (!standardLabels.has(label)) {
        const sourced = withCompletionSource(
          { label, type: "keyword", detail: "TikZ command", boost: 8 },
          "TikZ",
        );
        options.push(withDefaultCompletionInfo(sourced, "TikZ", label));
      }
    }
    for (const macro of await tikzTemplateCommands()) {
      // Do not suppress a user macro merely because it shadows a stock LaTeX
      // command. The template is the authored TikZ/TeX environment, so its
      // macro must remain visible and rank ahead of the generic catalogue row.
      const invocation = argumentScaffold(macro.label, macro.argumentCount);
      options.push(
        withCompletionSource(
          {
            label: macro.label,
            type: "keyword",
            detail:
              macro.argumentCount === undefined
                ? "TikZ template macro"
                : `TikZ template macro · ${macro.argumentCount} arg${macro.argumentCount === 1 ? "" : "s"}`,
            info: () =>
              completionInfoPanel({
                title: macro.label,
                source: "Macro",
                description: macro.declaration,
                syntax: "User-owned TikZ template macro",
                insertion: invocation,
                notes: macro.sourceFile === undefined ? undefined : [`Source: ${macro.sourceFile}`],
              }),
            boost: 30,
            apply:
              macro.argumentCount === undefined
                ? macro.label
                : (view, completion, from, to) => {
                    codeMirrorSnippet(invocation)(view, completion, from, to);
                  },
          },
          "Macro",
        ),
      );
    }
  }
  if (inTikzCd) {
    for (const label of TIKZCD_CONTROL_WORDS) {
      const sourced = withCompletionSource(
        { label, type: "keyword", detail: "tikz-cd command", boost: 8 },
        "tikzcd",
      );
      options.push(withDefaultCompletionInfo(sourced, "tikzcd", label));
    }
  }
  return options;
}

/** Standard control words in every parsed math/TikZ source region. */
export const texCommandSource: CompletionSource = async (ctx): Promise<CompletionResult | null> => {
  const tikz = tikzBlockAt(ctx.state, ctx.pos);
  const inMath = isMathPosition(ctx.state, ctx.pos);
  if (!inMath && tikz === null) {
    return null;
  }

  const environment = ctx.matchBefore(/\\begin\{[A-Za-z@*]*$/u);
  if (environment !== null) {
    const brace = environment.text.lastIndexOf("{");
    const standardNames = new Set(STANDARD_ENVIRONMENT_OPTIONS.map((option) => option.label));
    return {
      from: environment.from + brace + 1,
      options: [
        ...STANDARD_ENVIRONMENT_OPTIONS,
        ...mathJaxCompletionCatalogue()
          .environments.filter((label) => !standardNames.has(label))
          .map((label) => {
            const sourced = withCompletionSource(
              { label, type: "type" as const, detail: "MathJax environment" },
              "MathJax",
            );
            return withDefaultCompletionInfo(
              sourced,
              "MathJax",
              `\\begin{${label}}\n\t…\n\\end{${label}}`,
            );
          }),
      ],
    };
  }

  const command = ctx.matchBefore(/\\[A-Za-z@]*$/u);
  if (command === null) {
    return null;
  }

  return {
    from: command.from,
    options: await commandOptions(tikz !== null, tikz?.language === "tikzcd"),
  };
};

/** Test seam: reload the template-owned macro catalogue. */
export function __resetTikzTemplateCompletionCacheForTests(): void {
  tikzTemplateCommandPromise = null;
  userMathJaxCommandPromise = null;
  compilerTexCommandPromise = null;
  knownTexControlWordPromise = null;
}

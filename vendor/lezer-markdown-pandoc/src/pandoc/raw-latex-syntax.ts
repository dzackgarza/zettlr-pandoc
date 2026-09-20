/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/LaTeX.hs `rawLaTeXBlock` (line 153),
 * `rawLaTeXInline` (line 196), `blockCommands`, and `treatAsBlock`;
 * Markdown integration is src/Text/Pandoc/Readers/Markdown.hs
 * `rawLaTeXInline'` (line 2113) under Ext_raw_tex.
 */

/**
 * Pure recognition of Pandoc-style raw LaTeX environment blocks.
 *
 * This module deliberately knows nothing about CodeMirror. The editor parser,
 * custom Markdown AST, linting, and renderer adapters all use the same rules so
 * structural recognition cannot drift between surfaces.
 */

/**
 * Environments consumed by Pandoc's LaTeX `inlineEnvironment` parser. When
 * raw TeX is enabled in the Markdown reader these become RawInline(tex), not
 * RawBlock and not Math.
 *
 * Reference: Pandoc 3.10.2 commit f2ee5dfee866aab007a33552acc6bc01810c6918,
 * Text/Pandoc/Readers/LaTeX/Math.hs `inlineEnvironments` (lines 97-123),
 * reached from Text/Pandoc/Readers/LaTeX.hs `inline` / `rawLaTeXInline`.
 */
const PANDOC_INLINE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "displaymath", "math",
  "equation", "equation*", "gather", "gather*", "multline", "multline*",
  "eqnarray", "eqnarray*", "align", "align*", "alignat", "alignat*",
  "flalign", "flalign*", "dmath", "dmath*", "dgroup", "dgroup*",
  "darray", "darray*", "subequations",
]);

const ENVIRONMENT_OPEN_RE = /^\\begin\{([A-Za-z@]+\*?)\}/u;
const CONTROL_SEQUENCE_RE = /^\\([A-Za-z@]+)(\*)?/u;

/** Pandoc 3.10.2 Text.Pandoc.Readers.LaTeX blockCommands + treatAsBlock. */
const PANDOC_BLOCK_COMMANDS: ReadonlySet<string> = new Set([
  "PackageError",
  "addbibresource",
  "addcontentsline",
  "address",
  "addtocontents",
  "addtocounter",
  "author",
  "bibliography",
  "bibliographystyle",
  "blockcquote",
  "blockquote",
  "caption",
  "centerline",
  "chapter",
  "clearpage",
  "closing",
  "colorbox",
  "date",
  "dedication",
  "documentclass",
  "endinput",
  "epigraph",
  "extratitle",
  "fancybreak",
  "foreignblockcquote",
  "foreignblockquote",
  "framesubtitle",
  "frametitle",
  "frontispiece",
  "graphicspath",
  "hrule",
  "hspace",
  "hyperdef",
  "hypertarget",
  "hyphenblockcquote",
  "hyphenblockquote",
  "iftoggle",
  "ignore",
  "include",
  "input",
  "inputminted",
  "item",
  "listoffigures",
  "listoftables",
  "lowertitleback",
  "lstinputlisting",
  "makeglossary",
  "makeindex",
  "maketitle",
  "markboth",
  "markleft",
  "markright",
  "minisec",
  "newpage",
  "newtheorem",
  "newtoggle",
  "opening",
  "pagebreak",
  "par",
  "paragraph",
  "parbox",
  "part",
  "pdfannot",
  "pdfstringdef",
  "pfbreak",
  "plainbreak",
  "plainfancybreak",
  "publishers",
  "raggedright",
  "rule",
  "section",
  "setdefaultlanguage",
  "setmainlanguage",
  "signature",
  "special",
  "strut",
  "subfile",
  "subject",
  "subparagraph",
  "subsection",
  "subsubsection",
  "subtitle",
  "textcolor",
  "theoremstyle",
  "title",
  "titleformat",
  "titlehead",
  "togglefalse",
  "toggletrue",
  "uppertitleback",
  "usepackage",
  "vspace",
  "write",
]);

const NEW_COMMAND_DEFINITIONS = new Set([
  "newcommand",
  "renewcommand",
  "providecommand",
  "DeclareMathOperator",
  "DeclareRobustCommand",
]);
const NEW_ENVIRONMENT_DEFINITIONS = new Set([
  "newenvironment",
  "renewenvironment",
  "provideenvironment",
]);
const DEF_COMMANDS = new Set(["def", "gdef", "edef", "xdef"]);
const RAW_DEFINITION_COMMANDS = new Set([
  ...NEW_COMMAND_DEFINITIONS,
  ...NEW_ENVIRONMENT_DEFINITIONS,
  ...DEF_COMMANDS,
  "let",
  "newif",
  "global",
]);

function latexEnvironmentAtStart(text: string): string | null {
  const match = ENVIRONMENT_OPEN_RE.exec(text);
  return match?.[1] ?? null;
}

export function rawLatexEnvironmentAtStart(text: string): string | null {
  const environment = latexEnvironmentAtStart(text);
  return environment === null || PANDOC_INLINE_ENVIRONMENTS.has(environment)
    ? null
    : environment;
}

export function rawLatexBlockStartsAt(text: string): boolean {
  if (rawLatexEnvironmentAtStart(text) !== null) {
    return true;
  }
  const command = CONTROL_SEQUENCE_RE.exec(text);
  return (
    command !== null &&
    (PANDOC_BLOCK_COMMANDS.has(command[1]) || RAW_DEFINITION_COMMANDS.has(command[1]))
  );
}

function skipHorizontalSpace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor++;
  }
  return cursor;
}

function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && /\s/u.test(text[cursor])) {
    cursor++;
  }
  return cursor;
}

function escapedAt(text: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    count++;
  }
  return count % 2 === 1;
}

function balancedGroupEnd(
  text: string,
  from: number,
  open: "[" | "{",
  close: "]" | "}",
): number | null {
  if (text[from] !== open) {
    return null;
  }
  let depth = 0;
  let inComment = false;
  for (let cursor = from; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (inComment) {
      if (char === "\n") {
        inComment = false;
      }
      continue;
    }
    if (char === "%" && !escapedAt(text, cursor)) {
      inComment = true;
      continue;
    }
    if (char === open && !escapedAt(text, cursor)) {
      depth++;
    }
    if (char === close && !escapedAt(text, cursor)) {
      depth--;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }
  return null;
}

function controlSequenceEnd(text: string, from: number): number | null {
  if (text[from] !== "\\") {
    return null;
  }
  const match = /^\\(?:[A-Za-z@]+|.)/u.exec(text.slice(from));
  return match === null ? null : from + match[0].length;
}

function genericBlockCommandEnd(text: string, initialEnd: number): number {
  let cursor = initialEnd;
  let end = initialEnd;
  while (true) {
    const argumentStart = skipWhitespace(text, cursor);
    const char = text[argumentStart];
    if (char !== "[" && char !== "{") {
      break;
    }
    const argumentEnd = balancedGroupEnd(text, argumentStart, char, char === "[" ? "]" : "}");
    if (argumentEnd === null) {
      break;
    }
    cursor = argumentEnd;
    end = argumentEnd;
  }
  return end;
}

function newCommandDefinitionEnd(text: string, initialEnd: number): number | null {
  let cursor = skipWhitespace(text, initialEnd);
  if (text[cursor] === "*") {
    cursor = skipWhitespace(text, cursor + 1);
  }
  if (text[cursor] === "{") {
    const end = balancedGroupEnd(text, cursor, "{", "}");
    if (end === null) {
      return null;
    }
    cursor = end;
  } else {
    const end = controlSequenceEnd(text, cursor);
    if (end === null) {
      return null;
    }
    cursor = end;
  }
  cursor = skipWhitespace(text, cursor);
  for (let optional = 0; optional < 2 && text[cursor] === "["; optional++) {
    const end = balancedGroupEnd(text, cursor, "[", "]");
    if (end === null) {
      return null;
    }
    cursor = skipWhitespace(text, end);
  }
  if (text[cursor] === "{") {
    return balancedGroupEnd(text, cursor, "{", "}");
  }
  return controlSequenceEnd(text, cursor);
}

function newEnvironmentDefinitionEnd(text: string, initialEnd: number): number | null {
  let cursor = skipWhitespace(text, initialEnd);
  if (text[cursor] === "*") {
    cursor = skipWhitespace(text, cursor + 1);
  }
  const nameEnd = balancedGroupEnd(text, cursor, "{", "}");
  if (nameEnd === null) {
    return null;
  }
  cursor = skipWhitespace(text, nameEnd);
  for (let optional = 0; optional < 2 && text[cursor] === "["; optional++) {
    const end = balancedGroupEnd(text, cursor, "[", "]");
    if (end === null) {
      return null;
    }
    cursor = skipWhitespace(text, end);
  }
  for (let body = 0; body < 2; body++) {
    const end = balancedGroupEnd(text, cursor, "{", "}");
    if (end === null) {
      return null;
    }
    cursor = skipWhitespace(text, end);
  }
  return cursor;
}

function defCommandEnd(text: string, initialEnd: number): number | null {
  let cursor = skipHorizontalSpace(text, initialEnd);
  const nameEnd = controlSequenceEnd(text, cursor);
  if (nameEnd === null) {
    return null;
  }
  cursor = nameEnd;
  while (cursor < text.length) {
    if (text[cursor] === "{") {
      return balancedGroupEnd(text, cursor, "{", "}");
    }
    if (text[cursor] === "\n") {
      return null;
    }
    cursor++;
  }
  return null;
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const end = newline === -1 ? text.length : newline;
  let trimmed = end;
  while (trimmed > from && (text[trimmed - 1] === " " || text[trimmed - 1] === "\t")) {
    trimmed--;
  }
  return trimmed;
}

function rawLatexCommandEndAtStart(text: string): number | null {
  const match = CONTROL_SEQUENCE_RE.exec(text);
  if (match === null) {
    return null;
  }
  const name = match[1];
  const initialEnd = match[0].length;

  if (name === "global") {
    const nestedStart = skipWhitespace(text, initialEnd);
    const nestedEnd = rawLatexCommandEndAtStart(text.slice(nestedStart));
    return nestedEnd === null ? null : nestedStart + nestedEnd;
  }
  if (NEW_COMMAND_DEFINITIONS.has(name)) {
    return newCommandDefinitionEnd(text, initialEnd);
  }
  if (NEW_ENVIRONMENT_DEFINITIONS.has(name)) {
    return newEnvironmentDefinitionEnd(text, initialEnd);
  }
  if (DEF_COMMANDS.has(name)) {
    return defCommandEnd(text, initialEnd);
  }
  if (name === "let" || name === "newif") {
    return lineEnd(text, initialEnd);
  }
  if (!PANDOC_BLOCK_COMMANDS.has(name)) {
    return null;
  }
  return genericBlockCommandEnd(text, initialEnd);
}

function escapedPercent(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function withoutLatexComment(line: string): string {
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "%" && !escapedPercent(line, index)) {
      return line.slice(0, index);
    }
  }
  return line;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the offset immediately after the balanced closing environment.
 * `text` must start at the authored `\\begin{...}`. Newlines and arbitrary
 * blank lines are allowed. Same-name nesting is balanced, and TeX comments do
 * not contribute fake open/close tokens.
 */
export function rawLatexEnvironmentEnd(text: string, environment: string): number | null {
  if (latexEnvironmentAtStart(text) !== environment) {
    return null;
  }

  const escaped = escapeRegExp(environment);
  const tokenRe = new RegExp(`\\\\(?:begin|end)\\{${escaped}\\}`, "gu");
  let depth = 0;
  let lineFrom = 0;

  while (lineFrom <= text.length) {
    const newline = text.indexOf("\n", lineFrom);
    const lineTo = newline === -1 ? text.length : newline;
    const line = withoutLatexComment(text.slice(lineFrom, lineTo));

    tokenRe.lastIndex = 0;
    for (let match = tokenRe.exec(line); match !== null; match = tokenRe.exec(line)) {
      if (match[0].startsWith("\\begin")) {
        depth++;
      } else {
        depth--;
        if (depth === 0) {
          return lineFrom + match.index + match[0].length;
        }
      }
    }

    if (newline === -1) {
      break;
    }
    lineFrom = newline + 1;
  }

  return null;
}

/**
 * End offset for the subset of Pandoc RawInline(tex) syntax that begins with a
 * control sequence or one of Pandoc's LaTeX inline environments.
 *
 * Reference implementation: Pandoc 3.10.2 `rawLaTeXInline` in
 * Text/Pandoc/Readers/LaTeX.hs (lines 196-207), using `inline` and
 * `inlineEnvironment`. The executable Pandoc JSON reader is the differential
 * oracle for the admitted shapes.
 */
export function rawLatexInlineEndAtStart(text: string): number | null {
  const environment = latexEnvironmentAtStart(text);
  if (environment !== null) {
    if (!PANDOC_INLINE_ENVIRONMENTS.has(environment)) {
      return null;
    }
    return rawLatexEnvironmentEnd(text, environment);
  }

  const command = CONTROL_SEQUENCE_RE.exec(text);
  if (command === null) {
    return null;
  }

  const name = command[1];
  let cursor = command[0].length;

  // Pandoc's LaTeX reader does not greedily absorb arbitrary following groups.
  // `rawLaTeXInline` delegates to the actual command parser (`inlineCommands`)
  // and therefore consumes exactly the argument shape owned by that command.
  // Unknown commands accept optional [] groups followed by at most one braced
  // group; known multi-argument commands below mirror their literal entries in
  // LaTeX.hs `inlineCommands` (textcolor/colorbox, href, texorpdfstring, etc.).
  // This keeps `\textbf{raw} [label](...)` from swallowing the Markdown link.
  const MULTI_BRACED_ARGS: Readonly<Record<string, number>> = {
    href: 2,
    hyperlink: 2,
    texorpdfstring: 2,
    textcolor: 2,
    colorbox: 2,
  };
  const requiredBraces = MULTI_BRACED_ARGS[name] ?? 1;

  let consumedAny = false;
  let beforeSpace = cursor;
  cursor = skipHorizontalSpace(text, cursor);

  // TeX optional arguments precede the main braced argument(s). Pandoc's
  // command parsers use `option`/`skipopts` in these positions.
  while (text[cursor] === "[") {
    const end = balancedGroupEnd(text, cursor, "[", "]");
    if (end === null) return null;
    consumedAny = true;
    cursor = end;
    beforeSpace = cursor;
    cursor = skipHorizontalSpace(text, cursor);
  }

  let braces = 0;
  while (braces < requiredBraces && text[cursor] === "{") {
    const end = balancedGroupEnd(text, cursor, "{", "}");
    if (end === null) return null;
    consumedAny = true;
    braces++;
    cursor = end;
    if (braces < requiredBraces) {
      cursor = skipHorizontalSpace(text, cursor);
    }
  }

  if (consumedAny) {
    // Space after the final owned argument belongs back to Markdown.
    return cursor;
  }

  // A bare TeX control word gobbles following horizontal space. Pandoc keeps
  // those spaces in RawInline(tex), e.g. `\LaTeX   text`.
  return cursor > beforeSpace ? cursor : command[0].length;
}

/** Exact end of one editor-supported Pandoc RawBlock(tex) source unit. */
export function rawLatexBlockEndAtStart(text: string): number | null {
  const environment = rawLatexEnvironmentAtStart(text);
  if (environment !== null) {
    return rawLatexEnvironmentEnd(text, environment);
  }
  return rawLatexCommandEndAtStart(text);
}

/**
 * End of one Pandoc Markdown `rawTeXBlock`, which may aggregate several
 * adjacent LaTeX blocks.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * Text/Pandoc/Readers/Markdown.hs `rawTeXBlock`:
 * `many1 ((<>) <$> rawLaTeXBlock <*> spnl')`; `spnl'` accepts horizontal
 * whitespace plus at most one newline not followed by another newline.
 * Consequently adjacent raw blocks coalesce, but a blank line separates them.
 */
export function rawLatexBlockSequenceEndAtStart(text: string): number | null {
  const firstEnd = rawLatexBlockEndAtStart(text);
  if (firstEnd === null) return null;

  let end = firstEnd;
  for (;;) {
    let cursor = end;
    while (text[cursor] === " " || text[cursor] === "\t") cursor++;

    let afterGap = cursor;
    if (text.startsWith("\r\n", cursor)) {
      afterGap = cursor + 2;
    } else if (text[cursor] === "\n") {
      afterGap = cursor + 1;
    }

    if (afterGap !== cursor) {
      while (text[afterGap] === " " || text[afterGap] === "\t") afterGap++;
      // `spnl'` refuses the optional newline when it would create a blank line.
      if (text[afterGap] === "\n" || text.startsWith("\r\n", afterGap)) break;
    }

    const nextEnd = rawLatexBlockEndAtStart(text.slice(afterGap));
    if (nextEnd === null) break;
    end = afterGap + nextEnd;
  }
  return end;
}

export interface RawBlockSyntaxNode {
  from: number;
  to: number;
  getChildren: (name: string) => ReadonlyArray<{ from: number; to: number }>;
}

/**
 * Reconstruct the semantic raw-block source from parser-owned content ranges.
 * Container syntax such as `> ` or list indentation lives in the gaps between
 * these ranges and is therefore omitted, matching Pandoc's RawBlock payload.
 */
export function rawBlockSourceFromNode(
  node: RawBlockSyntaxNode,
  read: (from: number, to: number) => string,
): string {
  const content = node.getChildren("RawBlockContent");
  if (content.length === 0) {
    return read(node.from, node.to);
  }
  return content.map((range) => read(range.from, range.to)).join("");
}

export function rawBlockLineRangesFromNode(
  node: RawBlockSyntaxNode,
  read: (from: number, to: number) => string,
): Array<{ from: number; to: number }> {
  const content = node.getChildren("RawBlockContent");
  if (content.length === 0) {
    return [{ from: node.from, to: node.to }];
  }
  return content.map((range) => ({
    from: range.from,
    to: range.to > range.from && read(range.to - 1, range.to) === "\n" ? range.to - 1 : range.to,
  }));
}

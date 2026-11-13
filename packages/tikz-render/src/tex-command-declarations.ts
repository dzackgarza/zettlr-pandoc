/**
 * TeX control-word declarations shared by authoring-environment consumers.
 * This is intentionally lexical: it enumerates names declared by the user's
 * TeX sources without attempting to reimplement TeX expansion semantics.
 */

/** The LaTeX and etoolbox commands whose optional `[n]` gives the arity. */
const COUNTED_DECLARERS =
  "newcommand|renewcommand|providecommand|DeclareRobustCommand|newrobustcmd|renewrobustcmd|providerobustcmd";

/** The xparse commands, whose argument specification is not read here. */
const XPARSE_DECLARERS =
  "NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewExpandableDocumentCommand|RenewExpandableDocumentCommand";

const XPARSE_DECLARER_RE = new RegExp(`^(?:${XPARSE_DECLARERS})$`, "u");

/**
 * Group 1 is the declaring command and group 2 the name for the LaTeX
 * declarations; group 3 is the name of a primitive `\def`, group 4 the name
 * of a `\let`.
 */
const TEX_COMMAND_DECLARATION_RE = new RegExp(
  String.raw`\\(${COUNTED_DECLARERS}|DeclareMathOperator|DeclarePairedDelimiter(?:X|XPP)?|${XPARSE_DECLARERS})\*?\s*(?:\{\s*)?\\([A-Za-z@]+)|\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@]+)|\\let\s*\\([A-Za-z@]+)`,
  "gu",
);

export interface TexCommandDeclaration {
  name: string;
  /**
   * The number of arguments of the command, or undefined for an xparse
   * declaration, whose argument specification is not read.
   */
  argumentCount: number | undefined;
  index: number;
  line: number;
  declaration: string;
  context: string;
}

/**
 * The source with each TeX comment replaced by spaces, so offsets stay the
 * offsets of the source. A `%` after an odd number of backslashes is a
 * character, not a comment.
 */
export function maskTexComments(source: string): string {
  // String/regex offsets in JavaScript are UTF-16 code units; keep the masking
  // buffer indexed the same way even when TeX comments follow astral Unicode.
  const chars = source.split("");
  let index = 0;
  while (index < chars.length) {
    if (chars[index] !== "%") {
      index += 1;
      continue;
    }
    let backslashes = 0;
    let probe = index - 1;
    while (probe >= 0 && chars[probe] === "\\") {
      backslashes += 1;
      probe -= 1;
    }
    if (backslashes % 2 === 1) {
      index += 1;
      continue;
    }
    const newline = source.indexOf("\n", index);
    const end = newline < 0 ? chars.length : newline;
    chars.fill(" ", index, end);
    index = end;
  }
  return chars.join("");
}

/**
 * The arity of one declaration, read from the source after the declared
 * name (`at`).
 *
 * - `\newcommand{\cmd}[n][default]{…}` and its relatives (LaTeX 2e
 *   `\newcommand`, etoolbox `\newrobustcmd`): n, or 0 without `[n]`.
 * - `\DeclarePairedDelimiter{\cmd}{l}{r}`: 1 (mathtools manual, §3.6).
 * - `\DeclarePairedDelimiterX{\cmd}[n]{l}{r}{body}`: n.
 * - `\def\cmd#1#2{…}`: the highest parameter number before the body.
 * - `\DeclareMathOperator`, `\let`: 0.
 * - xparse: undefined.
 */
function argumentCountOf(declarer: string, visible: string, at: number): number | undefined {
  if (declarer === "def") {
    const body = visible.indexOf("{", at);
    const parameterText = visible.slice(at, body === -1 ? visible.length : body);
    const parameters = [...parameterText.matchAll(/#([1-9])/gu)].map((match) => Number(match[1]));
    return parameters.length === 0 ? 0 : Math.max(...parameters);
  }
  if (declarer === "let" || declarer === "DeclareMathOperator") {
    return 0;
  }
  if (declarer === "DeclarePairedDelimiter") {
    return 1;
  }
  if (XPARSE_DECLARER_RE.test(declarer)) {
    return undefined;
  }
  const counted = /\s*\}?\s*\[\s*(\d)\s*\]/uy;
  counted.lastIndex = at;
  const count = counted.exec(visible);
  return count === null ? 0 : Number(count[1]);
}

/**
 * Locate each authored macro declaration with enough surrounding source to
 * inspect multiline definitions without pretending to parse TeX expansion.
 * A declaration in a TeX comment is not one.
 */
export function texCommandDeclarationEntries(source: string): TexCommandDeclaration[] {
  const visible = maskTexComments(source);
  const sourceLines = source.split(/\r?\n/u);
  const lineStarts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  const entries: TexCommandDeclaration[] = [];
  const scanner = new RegExp(TEX_COMMAND_DECLARATION_RE.source, TEX_COMMAND_DECLARATION_RE.flags);
  for (const match of visible.matchAll(scanner)) {
    const bareName = match[2] ?? match[3] ?? match[4];
    if (bareName === undefined) {
      continue;
    }
    let lineIndex = 0;
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= match.index) {
      lineIndex += 1;
    }
    // lineStarts and sourceLines both split at every "\n", so lineIndex is a
    // valid source line.
    const declaration = sourceLines[lineIndex].trim();
    const contextStart = Math.max(0, lineIndex - 1);
    const contextEnd = Math.min(sourceLines.length, lineIndex + 4);
    let declarer = "let";
    if (match[1] !== undefined) {
      declarer = match[1];
    } else if (match[3] !== undefined) {
      declarer = "def";
    }
    entries.push({
      name: `\\${bareName}`,
      argumentCount: argumentCountOf(declarer, visible, match.index + match[0].length),
      index: match.index,
      line: lineIndex + 1,
      declaration,
      context: sourceLines.slice(contextStart, contextEnd).join("\n"),
    });
  }
  return entries;
}

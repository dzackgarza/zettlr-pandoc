/**
 * TeX control-word declarations shared by authoring-environment consumers.
 * This is intentionally lexical: it enumerates names declared by the user's
 * TeX sources without attempting to reimplement TeX expansion semantics.
 */

export const TEX_COMMAND_DECLARATION_RE =
  /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|DeclarePairedDelimiter(?:X|XPP)?|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewExpandableDocumentCommand|RenewExpandableDocumentCommand|newrobustcmd|renewrobustcmd|providerobustcmd)\*?\s*(?:\{\s*)?\\([A-Za-z@]+)|\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@]+)|\\let\s*\\([A-Za-z@]+)/gu;

export interface TexCommandDeclaration {
  name: string;
  index: number;
  line: number;
  declaration: string;
  context: string;
}

function maskTexComments(source: string): string {
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

/** Enumerate control words declared in one TeX source buffer. */
export function texCommandDeclarations(source: string): string[] {
  const commands = new Set<string>();
  for (const match of maskTexComments(source).matchAll(TEX_COMMAND_DECLARATION_RE)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) {
      commands.add(`\\${name}`);
    }
  }
  return [...commands].sort((a, b) => a.localeCompare(b));
}

/**
 * Locate each authored macro declaration with enough surrounding source to
 * inspect multiline definitions without pretending to parse TeX expansion.
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
    const bareName = match[1] ?? match[2] ?? match[3];
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
    entries.push({
      name: `\\${bareName}`,
      index: match.index,
      line: lineIndex + 1,
      declaration,
      context: sourceLines.slice(contextStart, contextEnd).join("\n"),
    });
  }
  return entries;
}

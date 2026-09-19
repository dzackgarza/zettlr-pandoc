/**
 * TeX control-word declarations shared by authoring-environment consumers.
 * This is intentionally lexical: it enumerates names declared by the user's
 * TeX sources without attempting to reimplement TeX expansion semantics.
 */

export const TEX_COMMAND_DECLARATION_RE =
  /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|DeclarePairedDelimiter(?:X|XPP)?|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewExpandableDocumentCommand|RenewExpandableDocumentCommand|newrobustcmd|renewrobustcmd|providerobustcmd)\*?\s*(?:\{\s*)?\\([A-Za-z@]+)|\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@]+)|\\let\s*\\([A-Za-z@]+)/gu;

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

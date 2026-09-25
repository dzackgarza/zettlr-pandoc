/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/LaTeX.hs `rawLaTeXBlock` (line 153),
 * `rawLaTeXInline` (line 196), `blockCommands`, and `treatAsBlock`;
 * Markdown integration is src/Text/Pandoc/Readers/Markdown.hs
 * `rawLaTeXInline'` (line 2113) under Ext_raw_tex.
 */

import { PANDOC_INLINE_COMMAND_NAMES } from './pandoc-inline-commands'
import { PANDOC_BLOCK_COMMAND_NAMES } from './pandoc-block-commands'
import {
  PANDOC_INLINE_COMMAND_STRATEGIES,
  type PandocInlineCommandStrategy,
} from './pandoc-inline-command-strategies'

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

export interface PandocLatexMathEnvironment {
  environment: string;
  display: boolean;
  end: number;
}

const ENVIRONMENT_OPEN_RE = /^\\begin\{([A-Za-z@]+\*?)\}/u;
const CONTROL_SEQUENCE_RE = /^\\([A-Za-z@]+)(\*)?/u;
const RAW_INLINE_CONTROL_WORD_RE = /^\\([\p{L}][\p{L}@]*)(\*)?/u;

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
  if (
    command !== null &&
    (PANDOC_BLOCK_COMMAND_NAMES.has(command[1]) || RAW_DEFINITION_COMMANDS.has(command[1]))
  ) {
    return true;
  }
  return genericRawMaybeBlockEndAtStart(text) !== null;
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

function bracketedGroupEnd(text: string, from: number): number | null {
  return balancedGroupEnd(text, from, '[', ']')
}

function skipPandocSp(text: string, from: number): number {
  let cursor = from
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
  if (text.startsWith('\r\n', cursor)) {
    cursor += 2
  } else if (text[cursor] === '\n' || text[cursor] === '\r') {
    cursor++
  } else {
    return cursor
  }
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
  return cursor
}

function controlWordEnd(text: string, from: number): number | null {
  const match = /^\\[\p{L}][\p{L}@]*/u.exec(text.slice(from))
  if (match === null) return null
  let cursor = from + match[0].length
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
  return cursor
}

/**
 * Port of LaTeX.Parsing `tokWith`: after optional whitespace, consume either a
 * balanced group, one following control sequence, or exactly one character of
 * ordinary text.
 */
function pandocTokEnd(text: string, from: number): number | null {
  let cursor = from
  while (/\s/u.test(text[cursor] ?? '')) cursor++
  if (text[cursor] === '{') return balancedGroupEnd(text, cursor, '{', '}')
  if (text[cursor] === '\\') return controlWordEnd(text, cursor)
  if (cursor >= text.length) return null
  if ('#$%&~_^\\{}'.includes(text[cursor])) return null
  return cursor + [...text.slice(cursor)][0].length
}

function pandocInlineTokenEnd(text: string, from: number): number | null {
  if (from >= text.length) return null
  if (text[from] === ' ' || text[from] === '\t') {
    let cursor = from
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
    return cursor
  }
  if (/\p{L}|\p{N}/u.test(text[from])) {
    const match = /^[\p{L}\p{N}]+/u.exec(text.slice(from))
    return match === null ? null : from + match[0].length
  }
  if (text[from] === '\\') {
    return controlWordEnd(text, from)
  }
  return from + [...text.slice(from)][0].length
}

function optionalRawoptEnd(text: string, from: number): number {
  const start = skipPandocSp(text, from)
  if (text[start] !== '[') return from
  const end = bracketedGroupEnd(text, start)
  return end === null ? from : skipPandocSp(text, end)
}

function skipRawoptsEnd(text: string, from: number): number {
  let cursor = from
  for (;;) {
    const next = optionalRawoptEnd(text, cursor)
    if (next === cursor) return cursor
    cursor = next
  }
}

function bracedEnd(text: string, from: number): number | null {
  const cursor = skipPandocSp(text, from)
  return text[cursor] === '{' ? balancedGroupEnd(text, cursor, '{', '}') : null
}

function optionalBracketEnd(text: string, from: number): number {
  const cursor = skipPandocSp(text, from)
  if (text[cursor] !== '[') return from
  const end = bracketedGroupEnd(text, cursor)
  return end ?? from
}

function verbatimEnd(text: string, from: number, bracePair = false): number | null {
  if (from >= text.length) return null
  const marker = text[from]
  if (/\s/u.test(marker)) return null
  const stop = bracePair && marker === '{' ? '}' : marker
  const end = text.indexOf(stop, from + 1)
  return end < 0 ? null : end + 1
}

function consumeCitationArgs(text: string, from: number, multi: boolean): number | null {
  let cursor = from
  let consumed = 0
  do {
    const before = cursor
    const firstOpt = optionalRawoptEnd(text, cursor)
    cursor = firstOpt
    const secondOpt = optionalRawoptEnd(text, cursor)
    cursor = secondOpt
    const groupStart = skipPandocSp(text, cursor)
    if (text[groupStart] !== '{') {
      cursor = before
      break
    }
    const groupEnd = balancedGroupEnd(text, groupStart, '{', '}')
    if (groupEnd === null) return null
    cursor = groupEnd
    consumed++
  } while (multi)
  return consumed > 0 ? cursor : null
}

function strategyEnd(
  strategy: PandocInlineCommandStrategy,
  text: string,
  from: number,
): number | null {
  switch (strategy) {
    case 'zero':
    case 'optional-numeric-bracket':
      return strategy === 'zero' ? from : optionalBracketEnd(text, from)
    case 'tok':
      return pandocTokEnd(text, from)
    case 'optional-tok':
      return pandocTokEnd(text, from) ?? from
    case 'two-tok': {
      const first = pandocTokEnd(text, from)
      return first === null ? null : pandocTokEnd(text, first)
    }
    case 'braced':
    case 'skipopts-braced':
    case 'rawopts-braced': {
      const cursor = strategy === 'braced' ? from : skipRawoptsEnd(text, from)
      return bracedEnd(text, cursor)
    }
    case 'rawopts-one-braced': {
      const cursor = skipRawoptsEnd(text, from)
      return bracedEnd(text, cursor)
    }
    case 'braced-tok': {
      const first = bracedEnd(text, from)
      return first === null ? null : pandocTokEnd(text, first)
    }
    case 'braced-sp-tok': {
      const first = bracedEnd(text, from)
      return first === null ? null : pandocTokEnd(text, skipPandocSp(text, first))
    }
    case 'skipopts-tok': {
      const cursor = skipRawoptsEnd(text, from)
      return pandocTokEnd(text, cursor)
    }
    case 'optional-rawopt-tok': {
      const cursor = optionalRawoptEnd(text, from)
      return pandocTokEnd(text, cursor)
    }
    case 'optional-rawopt-two-tok': {
      let cursor = optionalRawoptEnd(text, from)
      const first = pandocTokEnd(text, cursor)
      if (first === null) return null
      cursor = first
      return pandocTokEnd(text, cursor)
    }
    case 'skipopts-braced-tok': {
      let cursor = skipRawoptsEnd(text, from)
      const group = bracedEnd(text, cursor)
      if (group === null) return null
      return pandocTokEnd(text, group)
    }
    case 'braced-skipopts-tok': {
      const group = bracedEnd(text, from)
      if (group === null) return null
      return pandocTokEnd(text, skipRawoptsEnd(text, group))
    }
    case 'three-braced': {
      let cursor = from
      for (let i = 0; i < 3; i++) {
        const end = bracedEnd(text, cursor)
        if (end === null) return null
        cursor = end
      }
      return cursor
    }
    case 'three-braced-inline': {
      let cursor = from
      for (let i = 0; i < 3; i++) {
        const end = bracedEnd(text, cursor)
        if (end === null) return null
        cursor = end
      }
      return pandocInlineTokenEnd(text, cursor)
    }
    case 'optional-numeric-bracket-group': {
      const cursor = optionalBracketEnd(text, from)
      return bracedEnd(text, cursor)
    }
    case 'optional-bracket-braced': {
      const cursor = optionalRawoptEnd(text, from)
      return bracedEnd(text, cursor)
    }
    case 'verbatim':
      return verbatimEnd(text, from)
    case 'optional-bracket-verbatim': {
      const cursor = optionalRawoptEnd(text, from)
      return verbatimEnd(text, cursor, true)
    }
    case 'skipopts-braced-verbatim': {
      const cursor = skipRawoptsEnd(text, from)
      const group = bracedEnd(text, cursor)
      return group === null ? null : verbatimEnd(text, group, true)
    }
    case 'citation-single':
      return consumeCitationArgs(text, from, false)
    case 'citation-multi':
      return consumeCitationArgs(text, from, true)
    case 'citation-text': {
      const end = bracedEnd(text, from)
      if (end === null) return null
      const start = skipPandocSp(text, from)
      const body = text.slice(start + 1, end - 1)
      const hasCitation = [...body.matchAll(/\\([A-Za-z@]+)(\*)?/gu)].some(match => {
        const key = match[2] === '*' ? match[1] + '*' : match[1]
        const nested = PANDOC_INLINE_COMMAND_STRATEGIES[key] ??
          PANDOC_INLINE_COMMAND_STRATEGIES[match[1]]
        return nested === 'citation-single' || nested === 'citation-multi' ||
          nested === 'citation-author'
      })
      return hasCitation ? end : null
    }
    case 'citation-author':
      return consumeCitationArgs(text, from, false)
    case 'skipopts-group': {
      const cursor = skipRawoptsEnd(text, from)
      return bracedEnd(text, cursor)
    }
    case 'roman': {
      let cursor = from
      while (/\s/u.test(text[cursor] ?? '')) cursor++
      if (text[cursor] === '{') return bracedEnd(text, cursor)
      const match = /^\d+/u.exec(text.slice(cursor))
      return match === null ? null : cursor + match[0].length
    }
    case 'hyperref': {
      const option = optionalRawoptEnd(text, from)
      if (option !== from) {
        return pandocTokEnd(text, option)
      }
      let cursor = from
      for (let i = 0; i < 3; i++) {
        const group = bracedEnd(text, cursor)
        if (group === null) return null
        cursor = group
      }
      return pandocTokEnd(text, cursor)
    }
    case 'si-unit': {
      let cursor = optionalRawoptEnd(text, from)
      const group = bracedEnd(text, cursor)
      if (group !== null) return group
      return pandocTokEnd(text, cursor)
    }
    case 'si-value-unit': {
      let cursor = skipRawoptsEnd(text, from)
      const value = bracedEnd(text, cursor)
      if (value === null) return null
      cursor = optionalRawoptEnd(text, value)
      const unit = bracedEnd(text, cursor)
      return unit ?? pandocTokEnd(text, cursor)
    }
    case 'si-list-unit': {
      let cursor = optionalRawoptEnd(text, from)
      const values = bracedEnd(text, cursor)
      if (values === null) return null
      cursor = values
      return bracedEnd(text, cursor) ?? pandocTokEnd(text, cursor)
    }
    case 'si-range':
    case 'si-range-unit': {
      let cursor = skipRawoptsEnd(text, from)
      for (let i = 0; i < 2; i++) {
        const value = bracedEnd(text, cursor)
        if (value === null) return null
        cursor = optionalRawoptEnd(text, value)
      }
      if (strategy === 'si-range') return cursor
      return bracedEnd(text, cursor) ?? pandocTokEnd(text, cursor)
    }
    case 'until-fi': {
      const match = /\\fi\b/u.exec(text.slice(from))
      return match === null
        ? null
        : skipHorizontalSpace(text, from + match.index + match[0].length)
    }
    case 'inlines':
      return text.length
    case 'raw-command':
      return rawCommandArgsEnd(text, from)
  }
}

/** Port of the default branch of LaTeX.Parsing `getRawCommand`. */
function rawCommandArgsEnd(text: string, from: number): number {
  let cursor = skipRawoptsEnd(text, from)
  const dimen = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*[A-Za-z]+/u.exec(text.slice(cursor))
  if (dimen !== null) cursor += dimen[0].length
  for (;;) {
    const group = bracedEnd(text, cursor)
    if (group === null) return cursor
    cursor = group
  }
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
  if (!PANDOC_BLOCK_COMMAND_NAMES.has(name)) {
    return null;
  }
  return genericBlockCommandEnd(text, initialEnd);
}

/**
 * Port of LaTeX.hs `blockCommand.rawMaybeBlock` + Parsing.hs `getRawCommand`
 * for a command which is neither a definite block command nor a macro
 * definition. Pandoc first rejects names owned by `isInlineCommand`, then
 * accepts ordinary options/braced arguments and promotes the sequence only
 * when the physical line contains block commands and nothing else.
 *
 * The inline-command set is generated from the pinned Pandoc `inlineCommands`
 * construction in `pandoc-inline-commands.ts`; this function therefore does
 * not maintain an independent inline/block classification.
 */
function genericRawCommandUnitEnd(text: string): number | null {
  const match = CONTROL_SEQUENCE_RE.exec(text);
  if (
    match === null ||
    match[1] === 'begin' ||
    match[1] === 'end' ||
    match[1] === 'and' ||
    PANDOC_INLINE_COMMAND_NAMES.has(match[1])
  ) {
    return null;
  }

  let cursor = match[0].length;
  for (;;) {
    const beforeSpace = cursor;
    const argumentStart = skipHorizontalSpace(text, cursor);
    const opener = text[argumentStart];

    if (opener === '[' || opener === '{') {
      const end = balancedGroupEnd(
        text,
        argumentStart,
        opener,
        opener === '[' ? ']' : '}',
      );
      if (end === null) return null;
      cursor = end;
      continue;
    }

    // Beamer overlay specifications are part of Pandoc's `skipopts`.
    if (opener === '<') {
      const end = text.indexOf('>', argumentStart + 1);
      const newline = text.indexOf('\n', argumentStart + 1);
      if (end < 0 || (newline >= 0 && newline < end)) return null;
      cursor = end + 1;
      continue;
    }

    // Horizontal whitespace belongs to the raw command only when followed by
    // an owned argument. Otherwise it remains the block-line gap.
    cursor = beforeSpace;
    break;
  }
  return cursor;
}

function genericRawMaybeBlockEndAtStart(text: string): number | null {
  let first = genericRawCommandUnitEnd(text);
  if (first === null) return null;
  let cursor = first;

  // Pandoc `rest <- many blockCommand`: adjacent block commands with no
  // intervening space are one raw block. A known inline command aborts the
  // generic promotion, exactly as `guard $ not $ isInlineCommand name` does.
  while (text[cursor] === '\\') {
    const remainder = text.slice(cursor);
    const environment = rawLatexEnvironmentAtStart(remainder);
    let consumed: number | null = null;
    if (environment !== null) {
      consumed = rawLatexEnvironmentEnd(remainder, environment);
    }
    consumed ??= rawLatexCommandEndAtStart(remainder);
    consumed ??= genericRawCommandUnitEnd(remainder);
    if (consumed === null) return null;
    cursor += consumed;
  }

  const boundary = skipHorizontalSpace(text, cursor);
  if (boundary === text.length || text[boundary] === '\n' || text.startsWith('\r\n', boundary)) {
    return cursor;
  }
  return null;
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
 * Recognize the LaTeX math environments that Pandoc's Markdown reader keeps as
 * RawInline(tex). This is the exact `inlineEnvironments` set from Pandoc
 * 3.10.2 Text/Pandoc/Readers/LaTeX/Math.hs at the pinned reference commit.
 *
 * Pandoc's AST classification and the editor's visual rendering are separate:
 * these remain RawInline(tex) syntax nodes, while callers may render the
 * complete environment as mathematics. `math` is inline; the other admitted
 * environments are display mathematics.
 */
export function pandocLatexMathEnvironmentAtStart(
  text: string,
): PandocLatexMathEnvironment | null {
  const environment = latexEnvironmentAtStart(text);
  if (environment === null || !PANDOC_INLINE_ENVIRONMENTS.has(environment)) {
    return null;
  }
  const end = rawLatexEnvironmentEnd(text, environment);
  return end === null
    ? null
    : { environment, display: environment !== "math", end };
}

/**
 * End offset for Pandoc RawInline(tex) syntax beginning with a LaTeX control
 * word or one of Pandoc's LaTeX inline environments.
 *
 * Reference implementation: Pandoc 3.10.2 `rawLaTeXInline` in
 * Text/Pandoc/Readers/LaTeX.hs (lines 196-207). Control-word consumption is
 * driven by the generated upstream strategy table rather than a local arity
 * heuristic.
 */
export function rawLatexInlineEndAtStart(text: string): number | null {
  const environment = latexEnvironmentAtStart(text);
  if (environment !== null) {
    if (!PANDOC_INLINE_ENVIRONMENTS.has(environment)) {
      return null;
    }
    return rawLatexEnvironmentEnd(text, environment);
  }

  const command = RAW_INLINE_CONTROL_WORD_RE.exec(text);
  if (command === null) {
    return null;
  }

  const name = command[1];
  const starredName = command[2] === '*' ? name + '*' : name;
  const strategy = PANDOC_INLINE_COMMAND_STRATEGIES[starredName] ??
    PANDOC_INLINE_COMMAND_STRATEGIES[name];

  const cursor = skipHorizontalSpace(text, command[0].length);
  const end = strategy === undefined
    ? (PANDOC_BLOCK_COMMAND_NAMES.has(name) ? null : rawCommandArgsEnd(text, cursor))
    : strategyEnd(strategy, text, cursor);
  if (end === null) return null;

  let finalEnd = end;
  while (text.startsWith('{}', finalEnd)) finalEnd += 2;
  return finalEnd;
}

/** Exact end of one editor-supported Pandoc RawBlock(tex) source unit. */
export function rawLatexBlockEndAtStart(text: string): number | null {
  const environment = rawLatexEnvironmentAtStart(text);
  if (environment !== null) {
    return rawLatexEnvironmentEnd(text, environment);
  }
  return rawLatexCommandEndAtStart(text) ?? genericRawMaybeBlockEndAtStart(text);
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

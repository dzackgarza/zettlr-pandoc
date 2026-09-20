/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `attributes`, `attribute`,
 * `identifierAttr`, `classAttr`, `keyValAttr`, and `specialAttr`
 * (starting at line 643 in that revision).
 */

import { decodeHTMLStrict } from 'entities'

/**
 * Pandoc attribute-list syntax.
 *
 * This mirrors Pandoc's Markdown reader productions `attributes`, `attribute`,
 * `identifierAttr`, `classAttr`, `keyValAttr`, and `specialAttr` rather than
 * trying to approximate them with a brace regex. In particular, whitespace
 * between attributes may cross physical lines, and quoted values may contain
 * escaped quotes, braces, and a non-blank line break.
 */

export type PandocAttributeToken =
  | { kind: 'id', from: number, to: number, value: string }
  | { kind: 'class', from: number, to: number, value: string }
  | { kind: 'key-value', from: number, to: number, key: string, value: string }
  | { kind: 'special', from: number, to: number, value: 'unnumbered' }

export interface PandocAttributeListScan {
  from: number
  to: number
  tokens: PandocAttributeToken[]
}

export type PandocSyntaxScan<T> =
  | { status: 'match', value: T }
  | { status: 'incomplete' }
  | { status: 'no-match' }

function codePointAt (source: string, index: number): { char: string, width: number } | undefined {
  if (index >= source.length) {
    return undefined
  }
  const point = source.codePointAt(index)
  if (point === undefined) {
    return undefined
  }
  const char = String.fromCodePoint(point)
  return { char, width: char.length }
}

function isLetter (char: string): boolean {
  return /^\p{L}$/u.test(char)
}

function isAlphaNum (char: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(char)
}

function isIdentifierTail (char: string): boolean {
  return isAlphaNum(char) || '-_:'.includes(char) || char === '.'
}

function isPandocEscapable (char: string): boolean {
  // Pandoc's default markdown reader enables Ext_all_symbols_escapable:
  // any non-alphanumeric symbol except a physical line break may be escaped.
  return char !== '\n' && char !== '\r' && !isAlphaNum(char)
}

function scanIdentifier (source: string, start: number, firstMayBeNumber: boolean): number | undefined {
  const first = codePointAt(source, start)
  if (first === undefined || !(firstMayBeNumber ? isAlphaNum(first.char) : isLetter(first.char))) {
    return undefined
  }
  let index = start + first.width
  while (true) {
    const next = codePointAt(source, index)
    if (next === undefined || !isIdentifierTail(next.char)) {
      return index
    }
    index += next.width
  }
}

/** Pandoc's `spnl`: horizontal space, optionally one line break, then horizontal space. */
function skipSpnl (source: string, start: number): number {
  let index = start
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }
  if (source[index] === '\r' && source[index + 1] === '\n') {
    index += 2
  } else if (source[index] === '\n' || source[index] === '\r') {
    index++
  }
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }
  return index
}

function scanCharacterReference (source: string, start: number): { to: number, value: string } | undefined {
  const match = /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/.exec(source.slice(start))
  if (match === null) {
    return undefined
  }
  const decoded = decodeHTMLStrict(match[0])
  if (decoded === match[0]) {
    return undefined
  }
  return { to: start + match[0].length, value: decoded }
}

function scanQuotedValue (source: string, start: number, quote: '"'|"'"): PandocSyntaxScan<{ to: number, value: string }> {
  let index = start + 1
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === quote) {
      return { status: 'match', value: { to: index + 1, value } }
    }
    if (char === '\\') {
      if (index + 1 >= source.length) {
        return { status: 'incomplete' }
      }
      const escaped = codePointAt(source, index + 1)
      if (escaped === undefined) {
        return { status: 'incomplete' }
      }
      if (isPandocEscapable(escaped.char)) {
        value += escaped.char
        index += 1 + escaped.width
      } else {
        value += '\\'
        index++
      }
      continue
    }
    if (char === '&') {
      const reference = scanCharacterReference(source, index)
      if (reference !== undefined) {
        value += reference.value
        index = reference.to
        continue
      }
    }
    if (char === '\n' || char === '\r') {
      const newlineWidth = char === '\r' && source[index + 1] === '\n' ? 2 : 1
      const after = index + newlineWidth
      let probe = after
      while (source[probe] === ' ' || source[probe] === '\t') {
        probe++
      }
      // Pandoc's litChar admits an endline but not a blankline inside a quoted value.
      if (source[probe] === '\n' || source[probe] === '\r') {
        return { status: 'no-match' }
      }
      value += ' '
      index = after
      continue
    }
    const point = codePointAt(source, index)
    if (point === undefined) {
      return { status: 'incomplete' }
    }
    value += point.char
    index += point.width
  }
  return { status: 'incomplete' }
}

function scanUnquotedValue (source: string, start: number): { to: number, value: string } {
  let index = start
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '}') {
      break
    }
    if (char === '\\' && index + 1 < source.length) {
      const escaped = codePointAt(source, index + 1)
      if (escaped !== undefined && isPandocEscapable(escaped.char)) {
        value += escaped.char
        index += 1 + escaped.width
        continue
      }
    }
    const point = codePointAt(source, index)
    if (point === undefined) {
      break
    }
    value += point.char
    index += point.width
  }
  return { to: index, value }
}

function scanToken (source: string, start: number): PandocSyntaxScan<PandocAttributeToken> {
  const first = source[start]
  if (first === undefined) {
    return { status: 'incomplete' }
  }
  if (first === '#') {
    const to = scanIdentifier(source, start + 1, true)
    return to === undefined
      ? { status: 'no-match' }
      : { status: 'match', value: { kind: 'id', from: start, to, value: source.slice(start + 1, to) } }
  }
  if (first === '.') {
    const to = scanIdentifier(source, start + 1, false)
    return to === undefined
      ? { status: 'no-match' }
      : { status: 'match', value: { kind: 'class', from: start, to, value: source.slice(start + 1, to) } }
  }
  if (first === '-') {
    return { status: 'match', value: { kind: 'special', from: start, to: start + 1, value: 'unnumbered' } }
  }

  const keyEnd = scanIdentifier(source, start, false)
  if (keyEnd === undefined || source[keyEnd] !== '=') {
    return { status: 'no-match' }
  }
  const valueStart = keyEnd + 1
  const quote = source[valueStart]
  if (quote === '"' || quote === "'") {
    const quoted = scanQuotedValue(source, valueStart, quote)
    if (quoted.status !== 'match') {
      return quoted
    }
    return {
      status: 'match',
      value: {
        kind: 'key-value',
        from: start,
        to: quoted.value.to,
        key: source.slice(start, keyEnd),
        value: quoted.value.value,
      },
    }
  }

  const unquoted = scanUnquotedValue(source, valueStart)
  return {
    status: 'match',
    value: {
      kind: 'key-value',
      from: start,
      to: unquoted.to,
      key: source.slice(start, keyEnd),
      value: unquoted.value,
    },
  }
}

/** Parse one braced Pandoc attribute list beginning exactly at `start`. */
export function scanPandocAttributeList (source: string, start = 0): PandocSyntaxScan<PandocAttributeListScan> {
  if (source[start] !== '{') {
    return { status: 'no-match' }
  }
  let index = skipSpnl(source, start + 1)
  const tokens: PandocAttributeToken[] = []
  while (true) {
    if (index >= source.length) {
      return { status: 'incomplete' }
    }
    if (source[index] === '}') {
      return { status: 'match', value: { from: start, to: index + 1, tokens } }
    }
    const token = scanToken(source, index)
    if (token.status !== 'match') {
      return token
    }
    tokens.push(token.value)
    index = skipSpnl(source, token.value.to)
  }
}

export interface PandocFencedDivOpeningScan {
  markFrom: number
  markTo: number
  attribute?: PandocAttributeListScan
  bareClass?: { from: number, to: number, value: string }
  headerEnd: number
  headerLineCount: number
}

/**
 * Parse a Pandoc fenced-div opening starting at offset zero. This mirrors
 * Pandoc's `divFenced`: colon fence, horizontal space, `attributes` or one bare
 * non-space class, horizontal space, optional trailing colons, then endline.
 */
function scanBareDivClass (
  source: string,
  start: number,
  markTo: number,
): PandocSyntaxScan<PandocFencedDivOpeningScan> {
  let index = start
  const from = index
  while (index < source.length && !/[ \t\r\n]/.test(source[index])) {
    index++
  }
  if (index === from) {
    return index >= source.length ? { status: 'incomplete' } : { status: 'no-match' }
  }
  const bareClass = { from, to: index, value: source.slice(from, index) }
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }
  while (source[index] === ':') {
    index++
  }
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }
  const headerEnd = index
  if (index === source.length) {
    return {
      status: 'match',
      value: {
        markFrom: 0,
        markTo,
        bareClass,
        headerEnd,
        headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
      },
    }
  }
  if (source[index] === '\r' && source[index + 1] === '\n') {
    index += 2
  } else if (source[index] === '\n' || source[index] === '\r') {
    index++
  } else {
    return { status: 'no-match' }
  }
  return {
    status: 'match',
    value: {
      markFrom: 0,
      markTo,
      bareClass,
      headerEnd,
      headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
    },
  }
}

export function scanPandocFencedDivOpening (
  source: string,
  final = true,
): PandocSyntaxScan<PandocFencedDivOpeningScan> {
  let index = 0
  while (source[index] === ':') {
    index++
  }
  if (index < 3) {
    return { status: 'no-match' }
  }
  const markTo = index
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }

  const attributeStart = index
  if (source[index] !== '{') {
    return scanBareDivClass(source, attributeStart, markTo)
  }

  const scanned = scanPandocAttributeList(source, index)
  if (scanned.status === 'incomplete') {
    return final ? scanBareDivClass(source, attributeStart, markTo) : scanned
  }
  if (scanned.status === 'no-match') {
    // Pandoc wraps `attributes` in `try` and then falls back to a bare class.
    return scanBareDivClass(source, attributeStart, markTo)
  }

  const attribute = scanned.value
  index = attribute.to
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }
  while (source[index] === ':') {
    index++
  }
  while (source[index] === ' ' || source[index] === '\t') {
    index++
  }

  const headerEnd = index
  if (index === source.length) {
    return {
      status: 'match',
      value: {
        markFrom: 0,
        markTo,
        attribute,
        headerEnd,
        headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
      },
    }
  }
  if (source[index] === '\r' && source[index + 1] === '\n') {
    index += 2
  } else if (source[index] === '\n' || source[index] === '\r') {
    index++
  } else {
    return { status: 'no-match' }
  }

  return {
    status: 'match',
    value: {
      markFrom: 0,
      markTo,
      attribute,
      headerEnd,
      headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
    },
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Search query compilation and matching
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure half of the workspace search, modelled on VS
 *                  Code's search: a query is a text with three options
 *                  (match case, whole word, regular expression) plus glob
 *                  patterns for the files to include and exclude, and it
 *                  compiles to one regular expression and one path filter.
 *                  Matching a document yields absolute ranges, the line
 *                  each match sits on, and the one-line preview a result
 *                  row shows — before, matched, after — trimmed the way the
 *                  reference implementation trims it.
 *
 *                  Nothing here reads a file or holds state; the provider
 *                  walks the workspace, and the renderer draws what comes
 *                  back.
 *
 * END HEADER
 */

import picomatch from 'picomatch'

/** What the user typed into the search widget. */
export interface SearchQuery {
  text: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
  /** Comma-separated globs; empty means every file. */
  include: string
  /** Comma-separated globs; empty means no file is excluded. */
  exclude: string
}

/** One hit: where it is, which line it is on, and how the row reads. */
export interface SearchMatch {
  range: { from: number, to: number }
  /** One-based, the way an editor counts. */
  line: number
  preview: { before: string, inside: string, after: string }
}

/**
 * A compiled query, or the reason it compiled to nothing. An empty query is
 * not an error — it is what an empty search field means — and an unparsable
 * regular expression is reported so the widget can say so.
 */
export type CompiledQuery =
  | { status: 'ready', pattern: RegExp, includesPath: (relativePath: string) => boolean }
  | { status: 'empty' }
  | { status: 'invalid-regex', message: string }

/** VS Code trims the text before a match to this many characters. */
const PREVIEW_BEFORE = 26
/** and caps the whole preview here, so one long line cannot fill the pane. */
const PREVIEW_TOTAL = 250

function escapeRegExp (text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One glob the way a search field means it: `*.md` matches at any depth,
 * `src/*.md` only where it says. Several patterns are separated by commas.
 */
function compileGlobs (patterns: string): ((relativePath: string) => boolean) | undefined {
  const globs = patterns.split(',').map(glob => glob.trim()).filter(glob => glob !== '')
  if (globs.length === 0) {
    return undefined
  }
  const matchers = globs.map(glob => picomatch(glob.includes('/') ? glob : `**/${glob}`, { dot: true }))
  return relativePath => matchers.some(matches => matches(relativePath))
}

export function compileQuery (query: SearchQuery): CompiledQuery {
  if (query.text.trim() === '') {
    return { status: 'empty' }
  }

  const source = query.regex ? query.text : escapeRegExp(query.text)
  const bounded = query.wholeWord ? `\\b(?:${source})\\b` : source
  let pattern: RegExp
  try {
    pattern = new RegExp(bounded, query.matchCase ? 'g' : 'gi')
  } catch (err: unknown) {
    return { status: 'invalid-regex', message: err instanceof Error ? err.message : String(err) }
  }

  const included = compileGlobs(query.include)
  const excluded = compileGlobs(query.exclude)
  return {
    status: 'ready',
    pattern,
    includesPath: relativePath => {
      if (included !== undefined && !included(relativePath)) {
        return false
      }
      return excluded === undefined || !excluded(relativePath)
    }
  }
}

/**
 * Every match of the pattern in the document, in document order.
 *
 * @param   {string}  source   The document text
 * @param   {RegExp}  pattern  A global pattern from compileQuery
 *
 * @return  {SearchMatch[]}    The matches with their previews
 */
export function matchDocument (source: string, pattern: RegExp): SearchMatch[] {
  const matches: SearchMatch[] = []
  pattern.lastIndex = 0

  // The line the scan has reached, so counting lines stays linear in the
  // document rather than quadratic in the number of matches.
  let line = 1
  let lineStart = 0
  let scanned = 0

  let match = pattern.exec(source)
  while (match !== null) {
    const from = match.index
    for (let index = scanned; index < from; index++) {
      if (source[index] === '\n') {
        line++
        lineStart = index + 1
      }
    }
    scanned = from

    const to = from + match[0].length
    matches.push({ range: { from, to }, line, preview: previewOf(source, lineStart, from, to) })

    // A pattern that can match nothing (`a*`) would otherwise never advance.
    pattern.lastIndex = to > from ? to : from + 1
    match = pattern.exec(source)
  }

  return matches
}

/**
 * The one line a result row shows: what precedes the match on its line
 * (trimmed from the left), the matched text, and the rest of that line.
 */
function previewOf (source: string, lineStart: number, from: number, to: number): SearchMatch['preview'] {
  const lineBreak = source.indexOf('\n', from)
  const lineEnd = lineBreak === -1 ? source.length : lineBreak

  const fullBefore = source.slice(lineStart, from)
  const before = fullBefore.length > PREVIEW_BEFORE
    ? `…${fullBefore.slice(fullBefore.length - PREVIEW_BEFORE)}`
    : fullBefore

  const inside = source.slice(from, Math.min(to, lineEnd))
  const remaining = Math.max(0, PREVIEW_TOTAL - before.length - inside.length)
  const after = source.slice(Math.min(to, lineEnd), lineEnd).slice(0, remaining)

  return { before, inside, after }
}

/**
 * The text one match is replaced with: capture groups expanded against the
 * matched text, and, when the widget asks for it, the case of the match
 * carried over — an all-caps match takes an all-caps replacement, a
 * capitalised one a capitalised replacement.
 */
export function expandReplacement (matched: string, pattern: RegExp, replacement: string, preserveCase: boolean): string {
  const expanded = matched.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement)
  return preserveCase ? withCaseOf(matched, expanded) : expanded
}

function withCaseOf (matched: string, replacement: string): string {
  const hasLetters = matched !== matched.toLowerCase() || matched !== matched.toUpperCase()
  if (!hasLetters) {
    return replacement
  }
  if (matched === matched.toUpperCase()) {
    return replacement.toUpperCase()
  }
  if (matched === matched.toLowerCase()) {
    return replacement.toLowerCase()
  }
  if (matched[0] === matched[0].toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase()
  }
  return replacement
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation Parser
 * CVM-Role:        InlineParser
 * Maintainer:      Hendrik Erz / Zettlr Pandoc MathJax Fork
 * License:         GNU GPL v3
 *
 * Description:     Modular Lezer inline parser for Pandoc citations.
 *                  Faithfully tokenizes and parses bracketed multi-item
 *                  citations, narrative in-text citations, CSL locators,
 *                  suppress-author flags, prefixes, suffixes, and cross-reference
 *                  adjacencies into structured Lezer syntax trees and CiteItems.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState } from '@codemirror/state'
import { type SyntaxNode } from '@lezer/common'
import { type InlineParser, type Element as MDElement, type InlineContext } from '@lezer/markdown'

/**
 * Valid CSL locator terms per standard CSL specifications.
 */
export type CSL_LOCATOR_TERM =
  | 'article-locator'
  | 'book'
  | 'canon'
  | 'chapter'
  | 'column'
  | 'elocation'
  | 'equation'
  | 'figure'
  | 'folio'
  | 'issue'
  | 'line'
  | 'note'
  | 'opus'
  | 'page'
  | 'paragraph'
  | 'part'
  | 'rule'
  | 'section'
  | 'sub-verbo'
  | 'supplement'
  | 'table'
  | 'timestamp'
  | 'title-locator'
  | 'verse'
  | 'volume'

/**
 * Multilingual locator label dictionary (English, German, French).
 */
export const LOCATOR_LABELS: Record<CSL_LOCATOR_TERM, string[]> = {
  'article-locator': ['Art.', 'Artikel', 'art.', 'arts.', 'article', 'articles'],
  book: ['Buch', 'Bücher', 'B.', 'book', 'books', 'bk.', 'bks.', 'livre', 'livres', 'liv.'],
  canon: ['can.', 'cann.', 'canon', 'canons'],
  chapter: ['Kapitel', 'Kap.', 'chapter', 'chapters', 'c.', 'cc.', 'chap.', 'chaps.', 'chapitre', 'chapitres'],
  column: ['Spalte', 'Spalten', 'Sp.', 'column', 'columns', 'col.', 'cols', 'colonne', 'colonnes'],
  elocation: ['emplact', 'emplacement', 'emplacements', 'loc.', 'locs.', 'location', 'locations'],
  equation: ['équation', 'équations', 'eq.', 'eqq.', 'equation', 'equations'],
  figure: ['Abbildung', 'Abbildungen', 'Abb.', 'figure', 'figures', 'fig.', 'figs'],
  folio: ['Blatt', 'Blätter', 'Fol.', 'folio', 'folios', 'fol.', 'fols', 'fᵒ', 'fᵒˢ'],
  issue: ['Nummer', 'Nummern', 'Nr.', 'number', 'numbers', 'no.', 'nos.', 'numéro', 'numéros', 'nᵒ', 'nᵒˢ'],
  line: ['Zeile', 'Zeilen', 'Z', 'line', 'lines', 'l.', 'll.', 'ligne', 'lignes'],
  note: ['Note', 'Noten', 'N.', 'note', 'notes', 'n.', 'nn.'],
  opus: ['Opus', 'Opera', 'op.', 'opus', 'opera', 'opp.'],
  page: ['Seite', 'Seiten', 'S.', 'page', 'pages', 'p.', 'pp.'],
  paragraph: ['Absatz', 'Absätze', 'Abs.', '¶', '¶¶', 'paragraph', 'paragraphs', 'para.', 'paras', 'paragraphe', 'paragraphes', 'paragr.'],
  part: ['Teil', 'Teile', 'part', 'parts', 'pt.', 'pts', 'partie', 'parties', 'part.'],
  rule: ['règle', 'règles', 'r.', 'rr.', 'rule', 'rules'],
  section: ['Abschnitt', 'Abschnitte', 'Abschn.', '§', '§§', 'section', 'sections', 'sec.', 'secs', 'sect.'],
  'sub-verbo': ['sub verbo', 'sub verbis', 's.&#160;v.', 's.&#160;vv.', 's.v.', 's.vv.'],
  supplement: ['supp.', 'supps.', 'supplement', 'supplements'],
  table: ['tableau', 'tableaux', 'tab.', 'tbl.', 'tbls.', 'table', 'tables'],
  timestamp: [],
  'title-locator': ['titre', 'titres', 'tit.', 'titt.', 'title', 'titles'],
  verse: ['Vers', 'Verse', 'V.', 'verse', 'verses', 'v.', 'vv.', 'verset', 'versets'],
  volume: ['Band', 'Bände', 'Bd.', 'Bde.', 'volume', 'volumes', 'vol.', 'vols.']
}

export const SANITIZED_LOCATOR_LABELS: Partial<Record<CSL_LOCATOR_TERM, Set<string>>> = {}
export let ALL_VALID_LOCATOR_LABELS: Set<string> = new Set()

for (const key in LOCATOR_LABELS) {
  const setLabels = new Set(LOCATOR_LABELS[key as CSL_LOCATOR_TERM].map(e => e.toLowerCase()))
  SANITIZED_LOCATOR_LABELS[key as CSL_LOCATOR_TERM] = setLabels
  ALL_VALID_LOCATOR_LABELS = ALL_VALID_LOCATOR_LABELS.union(setLabels)
}

export const MAX_LOCATOR_LABEL_LENGTH = Math.max(...ALL_VALID_LOCATOR_LABELS.values().map(x => x.length))

const CHAR = {
  TAB: 9,
  LF: 10,
  CR: 13,
  SPACE: 32,
  BRACE_OPEN: 40,
  ASTERISK: 42,
  COMMA: 44,
  HYPHEN: 45,
  DOT: 46,
  SEMICOLON: 59,
  AT: 64,
  BRACKET_OPEN: 91,
  BRACKET_CLOSE: 93,
  UNDERSCORE: 95,
  CURLY_OPEN: 123,
  CURLY_CLOSE: 125,
  TILDE: 126
}

const ROMAN_NUMERAL_CODES = [
  67, 68, 73, 76, 77, 86, 88, // Uppercase C, D, I, L, M, V, X
  99, 100, 105, 108, 109, 118, 120 // Lowercase c, d, i, l, m, v, x
]

const CANONICAL_ROMAN_NUMERAL = /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i

/**
 * Verifies if text begins with a valid Roman numeral range (e.g. "IV", "xiv-xvi").
 */
function startsWithRomanNumeralLocator (text: string): boolean {
  const token = /^[CDILMVX]+(?:-[CDILMVX]+)*/i.exec(text)?.[0]
  if (token === undefined) {
    return false
  }

  const followingCharacter = text[token.length]
  if (followingCharacter !== undefined && /[A-Za-z]/.test(followingCharacter)) {
    return false
  }

  return token.split('-').every(part => CANONICAL_ROMAN_NUMERAL.test(part))
}

/**
 * Record of valid citation syntax node names emitted into the Lezer CST.
 */
export const NODES = {
  CITATION: 'Citation',
  MARK: 'CitationMark',
  PREFIX: 'CitationPrefix',
  AUTHORFLAG: 'CitationSuppressAuthorFlag',
  AT: 'CitationAtSign',
  KEY: 'CitationCitekey',
  LOCATOR: 'CitationLocator',
  SUFFIX: 'CitationSuffix'
}

export interface CiteItem {
  id: string
  locator?: string
  label?: keyof typeof LOCATOR_LABELS
  'suppress-author'?: boolean
  'author-only'?: boolean
  prefix?: string
  suffix?: string
}

export interface Citation {
  from: number
  to: number
  source: string
  composite: boolean
  items: CiteItem[]
}

/**
 * Converts a Citation syntax node and source markdown into typed CiteItems.
 */
export function nodeToCiteItem (node: SyntaxNode, markdown: string): Citation {
  if (node.type.name !== NODES.CITATION) {
    throw new Error(`Expected a Citation node, received type ${node.type.name}`)
  }

  const items: CiteItem[] = []
  let child = node.firstChild
  const composite = child !== null && child.type.name !== NODES.MARK

  let prefix: string | undefined
  let citekey: string | undefined
  let locator: string | undefined
  let label: CSL_LOCATOR_TERM | undefined
  let suffix: string | undefined
  let suppressAuthor: boolean | undefined

  while (child !== null) {
    if (child.type.name === NODES.PREFIX) {
      prefix = markdown.slice(child.from, child.to)
    } else if (child.type.name === NODES.KEY) {
      citekey = markdown.slice(child.from, child.to)
    } else if (child.type.name === NODES.LOCATOR) {
      locator = markdown.slice(child.from, child.to)
      const lclocIndex = locator.indexOf(' ')
      const lcloc = locator.substring(0, lclocIndex).toLowerCase()
      const explicitLabel = lclocIndex > 0 && ALL_VALID_LOCATOR_LABELS.has(lcloc) ? lcloc : undefined

      if (explicitLabel !== undefined) {
        for (const [ key, values ] of Object.entries(SANITIZED_LOCATOR_LABELS)) {
          if (values.has(lcloc)) {
            label = key as CSL_LOCATOR_TERM
            locator = locator.substring(lclocIndex + 1)
            break
          }
        }
      }
    } else if (child.type.name === NODES.SUFFIX) {
      suffix = markdown.slice(child.from, child.to)
    } else if (child.type.name === NODES.AUTHORFLAG) {
      suppressAuthor = true
    } else if (child.type.name === NODES.MARK && markdown.slice(child.from, child.to) === ';') {
      if (citekey !== undefined) {
        items.push({
          id: citekey,
          locator, prefix, suffix, label,
          'suppress-author': suppressAuthor
        })
      }
      prefix = undefined
      citekey = undefined
      locator = undefined
      label = undefined
      suffix = undefined
      suppressAuthor = undefined
    }

    child = child.nextSibling
  }

  if (citekey !== undefined) {
    items.push({
      id: citekey,
      locator, prefix, suffix, label,
      'suppress-author': suppressAuthor
    })
  }

  return {
    from: node.from,
    to: node.to,
    source: markdown.slice(node.from, node.to),
    composite,
    items
  }
}

/**
 * Extracts all Citation syntax nodes from an EditorState.
 */
export function extractCitationNodes (state: EditorState): SyntaxNode[] {
  const nodes: SyntaxNode[] = []
  syntaxTree(state).iterate({
    enter (node) {
      if (node.type.name === NODES.CITATION) {
        nodes.push(node.node)
        return false
      }
    }
  })
  return nodes
}

/**
 * Scans bracketed citations (e.g. `[@key, p. 23; @key2]`).
 */
function parseBracketedCitation (ctx: InlineContext, pos: number): { end: number, parts: MDElement[], keysFound: number } | null {
  const parts: MDElement[] = []
  let keysFound = 0
  const ctxEndPos = ctx.offset + ctx.text.length
  let i = pos

  parts.push(ctx.elt(NODES.MARK, i, ++i))

  let citekeyStart = -1
  let citekeyEnd = -1
  let citekeyInBrackets = false
  let locatorStart = -1
  let locatorEnd = -1
  let locatorInBrackets = false
  let citationPartStart = i

  for (; i < ctxEndPos; i++) {
    const prevCh = ctx.char(i - 1)
    const ch = ctx.char(i)
    const nextCh = ctx.char(i + 1)

    if (ch === CHAR.SEMICOLON || ch === CHAR.BRACKET_CLOSE) {
      if (citekeyStart < 0) {
        return null
      } else if (locatorStart > -1 && locatorEnd < 0) {
        parts.push(ctx.elt(NODES.LOCATOR, locatorStart, i))
      } else if (locatorEnd > -1 && locatorEnd < i) {
        parts.push(ctx.elt(NODES.SUFFIX, locatorInBrackets ? locatorEnd + 1 : locatorEnd, i))
      } else if (citekeyEnd < 0) {
        parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
        keysFound++
      } else if (citekeyEnd < i) {
        parts.push(ctx.elt(NODES.SUFFIX, citekeyEnd, i))
      }
    }

    if (ch === CHAR.SEMICOLON) {
      citekeyStart = -1
      citekeyEnd = -1
      citekeyInBrackets = false
      locatorStart = -1
      locatorEnd = -1
      locatorInBrackets = false
      citationPartStart = i + 1
      parts.push(ctx.elt(NODES.MARK, i, i + 1))
      continue
    }

    if (ch === CHAR.BRACKET_CLOSE) {
      parts.push(ctx.elt(NODES.MARK, i, ++i))
      break
    }

    if (citekeyStart < 0 && i === citationPartStart && [CHAR.SPACE, CHAR.LF, CHAR.CR, CHAR.TAB].includes(ch)) {
      citationPartStart = i + 1
      continue
    }

    if (ch === CHAR.HYPHEN && citekeyStart < 0 && nextCh === CHAR.AT) {
      if (i > citationPartStart) {
        parts.push(ctx.elt(NODES.PREFIX, citationPartStart, i))
      }
      parts.push(ctx.elt(NODES.AUTHORFLAG, i, i + 1))
      continue
    }

    if (ch === CHAR.AT && citekeyStart < 0 && [CHAR.SPACE, CHAR.HYPHEN, CHAR.BRACKET_OPEN, CHAR.SEMICOLON].includes(prevCh)) {
      if (i > citationPartStart && prevCh !== CHAR.HYPHEN) {
        parts.push(ctx.elt(NODES.PREFIX, citationPartStart, i))
      }
      parts.push(ctx.elt(NODES.AT, i, i + 1))
      citekeyStart = i + 1
      continue
    }

    if (citekeyStart > -1 && citekeyEnd < 0) {
      if (i === citekeyStart && ch === CHAR.CURLY_OPEN) {
        citekeyInBrackets = true
        parts.push(ctx.elt(NODES.MARK, i, i + 1))
        citekeyStart++
      } else if (citekeyInBrackets && ch === CHAR.CURLY_CLOSE) {
        parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
        keysFound++
        parts.push(ctx.elt(NODES.MARK, i, i + 1))
        citekeyEnd = i
      } else if (!/[\w:\.#$%&\-+?<>~/]/.test(String.fromCharCode(ch))) {
        parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
        keysFound++
        citekeyEnd = i

        if (ch === CHAR.CURLY_OPEN) {
          parts.push(ctx.elt(NODES.MARK, i, i + 1))
          locatorStart = i + 1
          locatorInBrackets = true
        }
      }
      continue
    }

    if (citekeyEnd > -1 && locatorStart < 0 && ch === CHAR.CURLY_OPEN) {
      locatorStart = i + 1
      locatorInBrackets = true
      parts.push(ctx.elt(NODES.MARK, i, i + 1))
      continue
    }

    // Explicit locator labels take precedence over implicit Roman numerals
    const slice = ctx.slice(i, i + MAX_LOCATOR_LABEL_LENGTH + 1)
    const lclocIndex = slice.indexOf(' ')
    const lcloc = slice.substring(0, lclocIndex).toLowerCase()
    const explicitLabel = lclocIndex > 0 && ALL_VALID_LOCATOR_LABELS.has(lcloc) ? lcloc : undefined

    if (citekeyEnd > -1 && locatorStart < 0 && prevCh === CHAR.SPACE && explicitLabel !== undefined) {
      if (/^[\s,\.:;+-]*$/.test(ctx.slice(citekeyEnd, i - 1))) {
        locatorStart = i
        i += explicitLabel.length + 1
      }
      continue
    }

    const startsImplicitLocator = (ch >= 48 && ch <= 57) || startsWithRomanNumeralLocator(ctx.slice(i, ctxEndPos))
    if (citekeyEnd > -1 && locatorStart < 0 && prevCh === CHAR.SPACE && startsImplicitLocator) {
      if (/^[\s,\.:;+-]*$/.test(ctx.slice(citekeyEnd, i - 1))) {
        locatorStart = i
      }
      continue
    }

    if (locatorStart > -1 && locatorEnd < 0) {
      if (locatorInBrackets && ch === CHAR.CURLY_CLOSE) {
        locatorEnd = i
        if (locatorEnd > locatorStart) {
          parts.push(ctx.elt(NODES.LOCATOR, locatorStart, locatorEnd))
        }
        parts.push(ctx.elt(NODES.MARK, i, i + 1))
        continue
      } else if ((ch < 48 || ch > 57) && !ROMAN_NUMERAL_CODES.includes(ch) && ch !== CHAR.HYPHEN && ch !== CHAR.DOT) {
        locatorEnd = i
        parts.push(ctx.elt(NODES.LOCATOR, locatorStart, locatorEnd))
        continue
      }
    }
  }

  if (parts.length > 0 && keysFound > 0) {
    return { end: i, parts, keysFound }
  }
  return null
}

/**
 * Scans narrative in-text citations (e.g. `@key` or `@key [p. 33]`).
 */
function parseNarrativeCitation (ctx: InlineContext, pos: number, hasHyphen: boolean): { end: number, parts: MDElement[], keysFound: number } | null {
  const parts: MDElement[] = []
  let keysFound = 0
  const ctxEndPos = ctx.offset + ctx.text.length
  let i = pos

  if (hasHyphen) {
    parts.push(ctx.elt(NODES.AUTHORFLAG, i, ++i))
  }

  parts.push(ctx.elt(NODES.AT, i, ++i))
  let citekeyStart = i

  if (ctx.char(i) === CHAR.CURLY_OPEN) {
    citekeyStart++
    parts.push(ctx.elt(NODES.MARK, i, ++i))
    while (i < ctxEndPos && ctx.char(i) !== CHAR.CURLY_CLOSE) {
      i++
    }
    if (ctx.char(i) !== CHAR.CURLY_CLOSE) {
      return null
    }
    parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
    keysFound++
    parts.push(ctx.elt(NODES.MARK, i, ++i))
  } else {
    while (i < ctxEndPos && /[\w:\.#$%&\-+?<>~/]/.test(String.fromCharCode(ctx.char(i)))) {
      i++
    }
    if (i === citekeyStart) {
      return null
    }
    if (/[\.,:;\?!]/.test(String.fromCharCode(ctx.char(i - 1)))) {
      --i
    }
    parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
    keysFound++
  }

  // Check for composite locator brackets: `@key [p. 33]`, excluding adjacent bracketed citations `[@...]`
  const hasBracket = i < ctxEndPos - 1 && ctx.char(i) === CHAR.SPACE && ctx.char(i + 1) === CHAR.BRACKET_OPEN
  const isBracketedCitation = hasBracket && (
    ctx.char(i + 2) === CHAR.AT ||
    (ctx.char(i + 2) === CHAR.HYPHEN && ctx.char(i + 3) === CHAR.AT)
  )

  if (hasBracket && !isBracketedCitation) {
    const citekeyEnd = i
    const temporaryParts: MDElement[] = []

    i++
    temporaryParts.push(ctx.elt(NODES.MARK, i, ++i))
    let intextSuffixStart = i
    let locatorStart = -1

    const slice = ctx.slice(i, i + MAX_LOCATOR_LABEL_LENGTH + 1)
    const lclocIndex = slice.indexOf(' ')
    const lcloc = slice.substring(0, lclocIndex).toLowerCase()
    const explicitLabel = lclocIndex > 0 && ALL_VALID_LOCATOR_LABELS.has(lcloc) ? lcloc : undefined

    if (explicitLabel !== undefined) {
      locatorStart = i
      i += explicitLabel.length + 1
    } else if ((ctx.char(i) >= 48 && ctx.char(i) <= 57) || ROMAN_NUMERAL_CODES.includes(ctx.char(i))) {
      locatorStart = i
    }

    if (locatorStart > -1) {
      while (i < ctxEndPos && ((ctx.char(i) >= 48 && ctx.char(i) <= 57) || ROMAN_NUMERAL_CODES.includes(ctx.char(i)) || ctx.char(i) === CHAR.HYPHEN || ctx.char(i) === CHAR.DOT)) {
        i++
      }
      temporaryParts.push(ctx.elt(NODES.LOCATOR, locatorStart, i))
      intextSuffixStart = i
    }

    while (i < ctxEndPos && ctx.char(i) !== CHAR.BRACKET_CLOSE) {
      const ch = ctx.char(i)
      const prevCh = ctx.char(i - 1)
      const nextCh = ctx.char(i + 1)

      if (ch === CHAR.SEMICOLON) {
        if (intextSuffixStart < i) {
          temporaryParts.push(ctx.elt(NODES.SUFFIX, intextSuffixStart, i))
        }
        temporaryParts.push(ctx.elt(NODES.MARK, i, i + 1))
        intextSuffixStart = i + 1
        i++
        continue
      }

      if (ch === CHAR.HYPHEN && nextCh === CHAR.AT) {
        temporaryParts.push(ctx.elt(NODES.AUTHORFLAG, i, i + 1))
        i++
        continue
      }

      if (ch === CHAR.AT && [CHAR.SPACE, CHAR.HYPHEN, CHAR.SEMICOLON].includes(prevCh)) {
        temporaryParts.push(ctx.elt(NODES.AT, i, i + 1))
        const keyStart = i + 1
        i++
        while (i < ctxEndPos && /[\w:\.#$%&\-+?<>~/]/.test(String.fromCharCode(ctx.char(i)))) {
          i++
        }
        temporaryParts.push(ctx.elt(NODES.KEY, keyStart, i))
        keysFound++
        intextSuffixStart = i
        continue
      }

      i++
    }

    if (ctx.char(i) === CHAR.BRACKET_CLOSE) {
      parts.push(...temporaryParts)
      if (intextSuffixStart < i) {
        parts.push(ctx.elt(NODES.SUFFIX, intextSuffixStart, i))
      }
      parts.push(ctx.elt(NODES.MARK, i, ++i))
    } else {
      i = citekeyEnd
    }
  }

  if (parts.length > 0 && keysFound > 0) {
    return { end: i, parts, keysFound }
  }
  return null
}

/**
 * Main Lezer inline parser for Pandoc citations.
 */
export const citationParser: InlineParser = {
  name: 'citations',
  before: 'Link',
  parse: (ctx, next, pos) => {
    if (next !== CHAR.AT && next !== CHAR.BRACKET_OPEN && next !== CHAR.HYPHEN) {
      return -1
    }

    const prevChar = ctx.char(pos - 1)
    const validBefore = Number.isNaN(prevChar) || [
      CHAR.BRACE_OPEN,
      CHAR.BRACKET_CLOSE,
      CHAR.ASTERISK,
      CHAR.UNDERSCORE,
      CHAR.TILDE,
      CHAR.LF,
      CHAR.CR,
      CHAR.TAB,
      CHAR.SPACE
    ].includes(prevChar)

    if (!validBefore) {
      return -1
    }

    if (next === CHAR.HYPHEN && ctx.char(pos + 1) !== CHAR.AT) {
      return -1
    }

    const parsed = next === CHAR.BRACKET_OPEN
      ? parseBracketedCitation(ctx, pos)
      : parseNarrativeCitation(ctx, pos, next === CHAR.HYPHEN)

    if (parsed !== null) {
      return ctx.addElement(ctx.elt(NODES.CITATION, pos, parsed.end, parsed.parts))
    }

    return -1
  }
}

/**
 * Pandoc citation grammar for the Lezer Markdown fork.
 *
 * Reference implementation: Pandoc 3.10.2, commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs: cite, textualCite, normalCite,
 * citeList, citation, prefix, and suffix (starting at `cite`, line 2230 in
 * that revision). Behavioral acceptance is differential against Pandoc JSON.
 */

import type { InlineParser, Element as MDElement } from '../markdown'
import { scanPandocAttributeList } from './attribute-syntax'
import { scanPandocAttributeList } from './attribute-syntax'

// See https://github.com/bwiernik/schema/blob/ff67ae11347a4fb444ef839d96549540e9516cc1/schemas/input/csl-citation.json#L144 ff
export type CSL_LOCATOR_TERM = 'article-locator' | 'book' | 'canon' | 'chapter'
    | 'column' | 'elocation' | 'equation' | 'figure' | 'folio' | 'issue' | 'line'
    | 'note' | 'opus' | 'page' | 'paragraph' | 'part' | 'rule' | 'section'
    | 'sub-verbo' | 'supplement' | 'table' | 'timestamp' | 'title-locator'
    | 'verse' | 'volume'

/**
 * The locatorLabels have been sourced from the CSL locale files. These are the
 * label strings that will trigger the parser to detect an explicit locator
 * label. The programmatic labels are the keys of this Record, and the labels
 * that users can use in various languages are the strings in the corresponding
 * arrays. As of now, only the French, German, and English locator labels have
 * been added to these lists of labels, since these are the three largest
 * communities of Zettlr. Going forward, adding more languages is straight-
 * forward; it just requires some time. But note that citeproc will
 * automatically use the correct language; i.e., using the label "pp." to denote
 * pages will correctly render "S." if using the German language for the output.
 *
 * @var {{ [key: string]: string[] }}}
 */
const locatorLabels: Record<CSL_LOCATOR_TERM, string[]> = {
  'article-locator': [ 'Art.', 'Artikel',  'art.', 'arts.', 'article', 'articles' ],
  book: [ 'Buch', 'Bücher', 'B.', 'book', 'books', 'bk.', 'bks.', 'livre', 'livres', 'liv.' ],
  canon: [ 'can.', 'cann.', 'canon', 'canons' ],
  chapter: [ 'Kapitel', 'Kap.', 'chapter', 'chapters', 'c.', 'cc.', 'chap.', 'chaps.', 'chapitre', 'chapitres' ],
  column: [ 'Spalte', 'Spalten', 'Sp.', 'column', 'columns', 'col.', 'cols', 'colonne', 'colonnes' ],
  elocation: [ 'emplact', 'emplacement', 'emplacements', 'loc.', 'locs.', 'location', 'locations' ],
  equation: [ 'équation', 'équations', 'eq.', 'eqq.', 'equation', 'equations' ],
  figure: [ 'Abbildung', 'Abbildungen', 'Abb.', 'figure', 'figures', 'fig.', 'figs' ],
  folio: [ 'Blatt', 'Blätter', 'Fol.', 'folio', 'folios', 'fol.', 'fols', 'fᵒ', 'fᵒˢ' ],
  issue: [ 'Nummer', 'Nummern', 'Nr.', 'number', 'numbers', 'no.', 'nos.', 'numéro', 'numéros', 'nᵒ', 'nᵒˢ' ],
  line: [ 'Zeile', 'Zeilen', 'Z', 'line', 'lines', 'l.', 'll.', 'ligne', 'lignes' ],
  note: [ 'Note', 'Noten', 'N.', 'note', 'notes', 'n.', 'nn.' ],
  opus: [ 'Opus', 'Opera', 'op.', 'opus', 'opera', 'opp.' ],
  page: [ 'Seite', 'Seiten', 'S.', 'page', 'pages', 'p.', 'pp.' ],
  paragraph: [ 'Absatz', 'Absätze', 'Abs.', '¶', '¶¶', 'paragraph', 'paragraphs', 'para.', 'paras', 'paragraphe', 'paragraphes', 'paragr.' ],
  part: [ 'Teil', 'Teile', 'part', 'parts', 'pt.', 'pts', 'partie', 'parties', 'part.' ],
  rule: [ 'règle', 'règles', 'r.', 'rr.', 'rule', 'rules' ],
  section: [ 'Abschnitt', 'Abschnitte', 'Abschn.', '§', '§§', 'section', 'sections', 'sec.', 'secs', 'sect.' ],
  'sub-verbo': [ 'sub verbo', 'sub verbis', 's.&#160;v.', 's.&#160;vv.', 's.v.', 's.vv.' ],
  supplement: [ 'supp.', 'supps.', 'supplement', 'supplements' ],
  table: [ 'tableau', 'tableaux', 'tab.', 'tbl.', 'tbls.', 'table', 'tables' ],
  timestamp: [],
  'title-locator': [ 'titre', 'titres', 'tit.', 'titt.', 'title', 'titles' ],
  verse: [ 'Vers', 'Verse', 'V.', 'verse', 'verses', 'v.', 'vv.', 'verset', 'versets' ],
  volume: [ 'Band', 'Bände', 'Bd.', 'Bde.', 'volume', 'volumes', 'vol.', 'vols.' ]
}

const sanitizedLocatorLabels: Partial<Record<CSL_LOCATOR_TERM, Set<string>>> = {}
let allValidLocatorLabels: Set<string> = new Set()

for (const key in locatorLabels) {
  // Normalize all labels to lowercase to handle small typos and convert to sets for quicker validation
  const setLabels = new Set(locatorLabels[key as CSL_LOCATOR_TERM].map(e => e.toLowerCase()))

  sanitizedLocatorLabels[key as CSL_LOCATOR_TERM] = setLabels
  // Flatten all labels for quick validation
  allValidLocatorLabels = allValidLocatorLabels.union(setLabels)
}

// Determine the longest locator length (so that we know below how many
// characters we must extract from the inline context).
const maxLocatorLabelLength = Math.max(...allValidLocatorLabels.values().map(x => x.length))

/**
 * I strongly believe that Marijn's approach of using character codepoints
 * instead of the characters themselves has a good reason, so we are going to
 * stick to the intended usage of the parser. However, I am a human and need
 * some labels for the numbers. This map essentially maps a few relevant code
 * points to their key names.
 */
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

// Character code points for upper/lower case roman numerals (CDILMVX).
const ROMAN_NUMERAL_CODES = [
  67, 68, 73, 76, 77, 86, 88, // Uppercase
  99, 100, 105, 108, 109, 118, 120 // Lowercase
]

const CANONICAL_ROMAN_NUMERAL = /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i
// Pandoc keys admit single internal punctuation between Unicode alphanumerics.
// https://pandoc.org/MANUAL.html#citations
const BARE_CITATION_KEY = /^[\p{L}\p{N}_]+(?:[:.#$%&+?<>~\/-][\p{L}\p{N}_]+)*/u

/**
 * Port the negative lookahead at the end of Pandoc `normalCite`:
 *
 *   notFollowedBy (try (void source) <|>
 *                  (Ext_bracketed_spans *> void attributes) <|>
 *                  void reference)
 *
 * A bracketed citation immediately followed by syntax that would make the
 * bracket group a link/reference/span is NOT a normal citation. Pandoc then
 * falls back to parsing the interior `@key` textually. This distinction is
 * observable in e.g. `[@a][label](url)`.
 */
function conflictsWithNormalCiteClose (ctx: Parameters<InlineParser['parse']>[0], pos: number): boolean {
  const next = ctx.char(pos)

  if (next === CHAR.CURLY_OPEN) {
    return scanPandocAttributeList(ctx.text, pos - ctx.offset).status === 'match'
  }

  if (next === CHAR.BRACKET_OPEN) {
    // Pandoc `reference` uses balanced brackets. We only need existence here,
    // not its parsed inline payload.
    let depth = 0
    for (let i = pos; i < ctx.end; i++) {
      const ch = ctx.char(i)
      if (ch === 92 /* \\ */) { i++; continue }
      if (ch === CHAR.BRACKET_OPEN) depth++
      if (ch === CHAR.BRACKET_CLOSE && --depth === 0) return true
    }
    return false
  }

  if (next === CHAR.BRACE_OPEN) {
    // This spelling is already handled above as Pandoc attributes.
    return false
  }

  if (next === 40 /* ( */) {
    // `source` is parenthesized and permits nested parenthesized URL chunks.
    // A balanced close is sufficient for the normal-citation exclusion; the
    // actual Link parser remains authoritative for the detailed destination.
    let depth = 0
    let angle = false
    let quote = 0
    for (let i = pos; i < ctx.end; i++) {
      const ch = ctx.char(i)
      if (ch === 92 /* \\ */) { i++; continue }
      if (quote !== 0) {
        if (ch === quote) quote = 0
        continue
      }
      if (ch === 34 /* " */ || ch === 39 /* ' */) { quote = ch; continue }
      if (ch === 60 /* < */) { angle = true; continue }
      if (ch === 62 /* > */ && angle) { angle = false; continue }
      if (angle) continue
      if (ch === 40) depth++
      if (ch === 41 && --depth === 0) return true
    }
  }

  return false
}

/**
 * Checks whether the text starts with a complete Roman-numeral locator. The
 * token must end before another letter and every range component must be a
 * canonical Roman numeral. Without these boundaries, suffixes such as
 * "Lemma" and "Corollary" are split after their initial L or C.
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
 * Record of all valid citation node names.
 */
export const NODES = {
  /**
   * The containing citation node
   */
  CITATION: 'Citation',
  /**
   * Any citation formatting character (brackets, etc.)
   */
  MARK: 'CitationMark',
  /**
   * Citation prefix
   */
  PREFIX: 'CitationPrefix',
  /**
   * "Suppress author"-flag.
   */
  AUTHORFLAG: 'CitationSuppressAuthorFlag',
  /**
   * The @-sign in front of the citekey
   */
  AT: 'CitationAtSign',
  /**
   * The citation key.
   */
  KEY: 'CitationCitekey',
  /**
   * The locator
   */
  LOCATOR: 'CitationLocator',
  /**
   * The citation suffix.
   */
  SUFFIX: 'CitationSuffix'
}

/**
 * Describes a single citation item. Composite citations have only one such item
 * but regular in-text citations can have multiple ones, divided by semicolons.
 */
export interface CiteItem {
  /**
   * Citekey -- required.
   */
  id: string
  /**
   * Locator (only a numerical range)
   */
  locator?: string
  /**
   * The locator label (what the locator describes). Defaults to "page."
   */
  label?: keyof typeof locatorLabels
  /**
   * Whether the citekey has the suppress author flag.
   */
  'suppress-author'?: boolean
  /**
   * Do not use.
   * @internal
   */
  'author-only'?: boolean
  /**
   * Anything before the citekey.
   */
  prefix?: string
  /**
   * Anything after the citekey or locator.
   */
  suffix?: string
}

export function parseCitationLocator (text: string): Pick<CiteItem, 'locator'|'label'> {
  for (const [label, names] of Object.entries(sanitizedLocatorLabels)) {
    for (const name of names) {
      if (text.toLowerCase().startsWith(name + ' ')) {
        return { locator: text.slice(name.length + 1), label: label as CSL_LOCATOR_TERM }
      }
    }
  }
  return { locator: text }
}

/** Interpret Pandoc's suffix as CSL locator plus the remaining authored affix. */
export function parseCitationSuffix (suffix: string): Pick<CiteItem, 'locator'|'label'|'suffix'> {
  const authored = suffix.replace(/\u00a0/g, ' ')
  const text = authored.replace(/^,?\s*/, '')
  if (text === '') return {}
  const braced = /^\{([^}]*)\}/.exec(text)
  if (braced !== null) {
    return { ...parseCitationLocator(braced[1]), suffix: text.slice(braced[0].length) }
  }
  const parsed = parseCitationLocator(text)
  const locatorText = parsed.locator
  if (locatorText === undefined) throw new Error('Citation locator text is unavailable')
  const numeric = /^[0-9]+(?:[.\-–][0-9]+)*/.exec(locatorText)?.[0]
  const roman = startsWithRomanNumeralLocator(locatorText) ? /^[CDILMVX]+(?:-[CDILMVX]+)*/i.exec(locatorText)?.[0] : undefined
  const locator = numeric ?? roman
  if (locator === undefined) return { suffix: authored }
  return { locator, label: parsed.label, suffix: locatorText.slice(locator.length) }
}

/**
 * A full citation cluster.
 */
export interface Citation {
  /**
   * Start in the source
   */
  from: number
  /**
   * End in the source
   */
  to: number
  /**
   * Raw source string
   */
  source: string
  /**
   * Whether its composite (@AuthorYear [p. 23]) or not ([@AuthorYear, p. 23]).
   */
  composite: boolean
  /**
   * All items in this citation. Length === 1 if composite is true.
   */
  items: CiteItem[]
}

// Here follows the actual parser
export const citationParser: InlineParser = {
  name: 'citations',
  // This inline parser must be run before the Link parser, as
  // `[@citekey, p. 123]` will otherwise be detected as a link.
  before: 'Link',
  // NOTE: I discovered that elements MUST UNDER ALL CIRCUMSTANCES be inserted
  // SORTED. The library will omit any elements added whose from/to positions do
  // not match up with the rest of the elements. (This is especially important
  // for finishing the prefix below).
  parse: (ctx, next, pos) => {
    // Any potentially valid citation starts with an opening bracket, an @, or
    // a hyphen.
    if (next !== CHAR.AT && next !== CHAR.BRACKET_OPEN && next !== CHAR.HYPHEN) {
      return -1
    }

    // Pandoc's `normalCite` begins directly at `[` and imposes no condition on
    // the preceding character, so constructs such as `` `code`[@key] `` are
    // valid citations. The boundary restriction belongs only to textual
    // `@key` / `-@key` recognition, where it prevents email-like false
    // positives. Reference: Markdown.hs `cite`, `normalCite`, `textualCite`.
    if (next !== CHAR.BRACKET_OPEN) {
      const prevChar = ctx.char(pos - 1)
      const validBefore = Number.isNaN(prevChar) || [
        CHAR.BRACE_OPEN,
        CHAR.BRACKET_OPEN,
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
    }

    // Quick additional check to save us some headaches, because if `next` is a
    // hyphen, it MUST be followed by an @ to be considered a valid citation.
    if (next === CHAR.HYPHEN && ctx.char(pos + 1) !== CHAR.AT) {
      return -1
    }

    // Now we have two options: If the character was either an @ or a hyphen,
    // we are dealing with an inline-citation. Otherwise, we have a regular
    // in-text citation.

    // What we essentially do below is implement a basic character-parser that
    // collects the various elements of a citation in `parts`, and emits a full
    // citation at the end.
    // NOTE: Each citation has two named elements in a specific order: First a
    // citekey, second an optional locator. Anything before the citekey is by
    // definition the prefix, and anything after the locator (if present,
    // otherwise after the citekey) up until the next semicolon or end bracket
    // is by definition considered suffix.

    // We collect all (non-nesting) children in this array.
    const parts: MDElement[] = []

    // This is necessary, because even a citation with zero proper citekeys will
    // otherwise be detected as valid.
    let citekeysFound = 0

    // We often need to ensure that we do not overrun the maximum inline context
    // length.
    const ctxEndPos = ctx.offset + ctx.text.length

    // Preset the current position in our parsing
    let i = pos

    // First, deal with regular in-text citations, as these are more complex.
    if (next === CHAR.BRACKET_OPEN) {
      // NOTE the increment. These are used in several parts to keep the code a
      // bit cleaner. I have avoided using `i++`, and instead used only `++i` to
      // signal that we are shifting the index.
      parts.push(ctx.elt(NODES.MARK, i, ++i))

      // Set up the state. We have to find two elements within each citation --
      // a citekey, and an optional locator. Prefix and suffix can be computed
      // from that. We ignore everything between citekey and locator.
      let citekeyStart = -1
      let citekeyEnd = -1
      let citekeyInBrackets = false

      let locatorStart = -1
      let locatorEnd = -1
      let locatorInBrackets = false

      // We need this to account for multiple citekeys. It allows us to properly
      // insert prefix-nodes in multi-citekey-citations.
      let citationPartStart = i
      let closed = false
      let nestedBrackets = 0

      // Now go through the character stream and parse the citation parts.
      for (/* i is at the correct position */; i < ctxEndPos; i++) {
        // NOTE NOTE: Since the individual parsing rules are slightly more
        // complex, I could not use a switch statement, nor an if-else branching
        // since both was less readable than I have wished for. So instead I
        // use individual if-branches that usually end in a `continue` or break.
        // Note that some of those branches do not, meaning they are essentially
        // 'fall-through.'

        // Iteration setup
        const prevCh = ctx.char(i - 1) // Might be Number.NaN
        const ch = ctx.char(i)
        const nextCh = ctx.char(i + 1) // Might be Number.NaN

        if (citekeyInBrackets && citekeyEnd < 0 && i > citekeyStart && ch !== CHAR.CURLY_CLOSE) {
          if (/\s/u.test(String.fromCharCode(ch))) return -1
          continue
        }

        if (ch === CHAR.BRACKET_OPEN) {
          nestedBrackets++
          continue
        }
        if (ch === CHAR.BRACKET_CLOSE && nestedBrackets > 0) {
          nestedBrackets--
          continue
        }
        if (nestedBrackets > 0) continue

        if (ch === CHAR.SEMICOLON || ch === CHAR.BRACKET_CLOSE) {
          // Regardless of whether another citation part starts or the entire
          // citation is now finished, we must close any opened and unfinished
          // nodes here.
          if (citekeyStart < 0) {
            // This happens with bracketed text that does not contain an @-sign.
            // Up until here, those things will indeed be considered valid, but
            // we have to explicitly return here to avoid any errors later on.
            return -1
          } else if (locatorStart > -1 && locatorEnd < 0) {
            // Locator reaches until the end of the part
            parts.push(ctx.elt(NODES.LOCATOR, locatorStart, i))
          } else if (locatorEnd > -1 && locatorEnd < i) {
            // Locator has been finalized -> suffix.
            parts.push(ctx.elt(NODES.SUFFIX, locatorInBrackets ? locatorEnd + 1 : locatorEnd, i))
          } else if (citekeyEnd < 0) {
            // Non-bracketed citekey with no locator and no suffix.
            parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
            citekeysFound++
          } else if (citekeyEnd < i) {
            // No locator, but there were characters after the citekey -> suffix
            parts.push(ctx.elt(NODES.SUFFIX, citekeyEnd, i))
          }
        }

        if (ch === CHAR.SEMICOLON) {
          // Multiple citations are divided by semicolons, so afterwards a new
          // citation part starts -> reset the state.
          citekeyStart = -1
          citekeyEnd = -1
          citekeyInBrackets = false
          locatorStart = -1
          locatorEnd = -1
          locatorInBrackets = false
          citationPartStart = i + 1 // Next citation starts after the semicolon.
          parts.push(ctx.elt(NODES.MARK, i, i + 1))
          continue
        }

        if (ch === CHAR.BRACKET_CLOSE) {
          // End-condition -- marks the finish of the entire parsing.
          parts.push(ctx.elt(NODES.MARK, i, ++i))
          if (conflictsWithNormalCiteClose(ctx, i)) {
            return -1
          }
          closed = true
          break // Stop iterating; citation is between pos and i.
        }

        if (citekeyStart < 0 && i === citationPartStart && [ CHAR.SPACE, CHAR.LF, CHAR.CR, CHAR.TAB ].includes(ch)) {
          // Whitespace at the start of a citation part separates it from the
          // preceding semicolon. It is part of the citation syntax, so it must
          // not end up in the prefix of this part.
          citationPartStart = i + 1
          continue
        }

        if (ch === CHAR.HYPHEN && citekeyStart < 0 && nextCh === CHAR.AT) {
          // Suppress-author-flag: Before citekey starts, must be followed by @
          if (i > citationPartStart) {
            // Add prefix node. Note that we have to add nodes in proper sorted
            // order.
            parts.push(ctx.elt(NODES.PREFIX, citationPartStart, i))
          }
          parts.push(ctx.elt(NODES.AUTHORFLAG, i, i + 1))
          continue
        }

        if (ch === CHAR.AT && citekeyStart < 0 && [ CHAR.SPACE, CHAR.HYPHEN, CHAR.BRACKET_OPEN, CHAR.SEMICOLON ].includes(prevCh)) {
          // Start citekey (must be preceded by [, a space, a semicolon, or -)
          if (i > citationPartStart && prevCh !== CHAR.HYPHEN) {
            // Add prefix node. Note that we have to add nodes in proper sorted
            // order.
            parts.push(ctx.elt(NODES.PREFIX, citationPartStart, i))
          }

          parts.push(ctx.elt(NODES.AT, i, i + 1))
          citekeyStart = i + 1 // Key excludes the '@'
          if (ctx.char(citekeyStart) !== CHAR.CURLY_OPEN) {
            const key = BARE_CITATION_KEY.exec(ctx.slice(citekeyStart, ctxEndPos))?.[0]
            if (key === undefined) return -1
            citekeyEnd = citekeyStart + key.length
            parts.push(ctx.elt(NODES.KEY, citekeyStart, citekeyEnd))
            citekeysFound++
            i = citekeyEnd - 1
          }
          continue
        }

        if (citekeyStart > -1 && citekeyEnd < 0) {
          // We are inside the citekey
          if (i === citekeyStart && ch === CHAR.CURLY_OPEN) {
            citekeyInBrackets = true // Citekey is in brackets
            parts.push(ctx.elt(NODES.MARK, i, i + 1))
            citekeyStart++
          } else if (citekeyInBrackets && ch === CHAR.CURLY_CLOSE) {
            // Citekey is in brackets, and we found the closing bracket
            if (i === citekeyStart) return -1
            parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
            citekeysFound++
            parts.push(ctx.elt(NODES.MARK, i, i + 1))
            citekeyEnd = i + 1
          }
          // Else: still inside a citekey, so just swallow the character
          continue
        }

        // Now we're past the citekey. There's only a suffix and a locator
        // afterwards. If we find a locator, use it; if we don't, everything
        // else is suffix. NOTE: If there is a locator, anything between citekey
        // end and locator start is going to be ignored.
        if (citekeyEnd > -1 && locatorStart < 0 && ch === CHAR.CURLY_OPEN) {
          // Locator is present; contained within curly brackets.
          locatorStart = i + 1
          locatorInBrackets = true
          parts.push(ctx.elt(NODES.MARK, i, i + 1))
          continue
        }

        // Check explicit locator labels first so labels like "liv." or "c." or "v."
        // are never misparsed as implicit Roman numerals.
        const slice = ctx.slice(i, i + maxLocatorLabelLength + 1)
        const lclocIndex = slice.indexOf(' ')
        const lcloc = slice.substring(0, lclocIndex).toLowerCase()
        const explicitLabel = lclocIndex > 0 && allValidLocatorLabels.has(lcloc) ? lcloc : undefined

        if (citekeyEnd > -1 && locatorStart < 0 && prevCh === CHAR.SPACE && explicitLabel !== undefined) {
          // First, check if there are only punctuation marks and spaces between
          // the citekey end and the locator start. If not, we should not detect
          // this as a locator.
          if (/^[\s,\.:;+-]*$/.test(ctx.slice(citekeyEnd, i - 1))) {
            // Found a valid locator label -> begin explicit locator
            locatorStart = i
            // Move i forward until after the space so that the implicit locator
            // logic can take over. This way, regardless of how a locator starts,
            // its end will be found the same way.
            i += explicitLabel.length + 1
          }
          continue
        }

        // Implicit locators: digits or canonical Roman numerals
        const startsImplicitLocator = (ch >= 48 && ch <= 57) || startsWithRomanNumeralLocator(ctx.slice(i, ctxEndPos))
        if (citekeyEnd > -1 && locatorStart < 0 && prevCh === CHAR.SPACE && startsImplicitLocator) {
          // First, check if there are only punctuation marks and spaces between
          // the citekey end and the locator start. If not, we should not detect
          // this as a locator.
          if (/^[\s,\.:;+-]*$/.test(ctx.slice(citekeyEnd, i - 1))) {
            // Found a number -> begin implicit locator
            locatorStart = i
          }
          continue
        }

        if (locatorStart > -1 && locatorEnd < 0) {
          // We are inside the locator
          if (locatorInBrackets && ch === CHAR.CURLY_CLOSE) {
            // Curly brackets locators are easy
            locatorEnd = i
            // Bracketed locators can be empty ({}) -> in that case do not add
            // it to the syntax tree.
            if (locatorEnd > locatorStart) {
              parts.push(ctx.elt(NODES.LOCATOR, locatorStart, locatorEnd))
            }
            parts.push(ctx.elt(NODES.MARK, i, i + 1))
            continue
          } else if (((ch < 48 || ch > 57) && !ROMAN_NUMERAL_CODES.includes(ch) && ch !== CHAR.HYPHEN && ch !== CHAR.DOT)) {
            // Both implicit and explicit locators end if we no longer have
            // valid (implicit) locator characters.
            locatorEnd = i
            parts.push(ctx.elt(NODES.LOCATOR, locatorStart, locatorEnd))
            continue
          }
        }
      }
      if (!closed) {
        return -1
      }

      // Pandoc `normalCite` explicitly rejects a bracketed citation when the
      // closing `]` is immediately followed by link-source syntax, a bracketed
      // span attribute list, or a reference label. In that situation the
      // opening `[` remains literal and the inner `@key` is parsed by
      // `textualCite` instead. This is observable for constructs such as
      // `[@key][label](target)` and `[@key]{.class}`.
      //
      // Reference: Markdown.hs `normalCite`, lines 2302-2313 at the pinned
      // Pandoc commit.
      const localAfter = i - ctx.offset
      const following = ctx.text.slice(localAfter)
      const followedBySource = (() => {
        if (!following.startsWith('(')) return false
        let depth = 0
        let quote: '"'|"'"|undefined
        let escaped = false
        for (let cursor = 0; cursor < following.length; cursor++) {
          const char = following[cursor]
          if (escaped) {
            escaped = false
            continue
          }
          if (char === '\\') {
            escaped = true
            continue
          }
          if (quote !== undefined) {
            if (char === quote) quote = undefined
            continue
          }
          if (char === '"' || char === "'") {
            quote = char
            continue
          }
          if (char === '(') depth++
          if (char === ')') {
            depth--
            if (depth === 0) return true
          }
        }
        return false
      })()
      const followedByAttributes = following.startsWith('{') &&
        scanPandocAttributeList(ctx.text, localAfter).status === 'match'
      const followedByReference = following.startsWith('[') && !following.startsWith('[^') && (() => {
        let depth = 0
        let escaped = false
        for (const char of following) {
          if (escaped) {
            escaped = false
            continue
          }
          if (char === '\\') {
            escaped = true
            continue
          }
          if (char === '[') depth++
          if (char === ']') {
            depth--
            if (depth === 0) return true
          }
        }
        return false
      })()
      if (followedBySource || followedByAttributes || followedByReference) {
        return -1
      }
    } else {
      // Inline-citation. That one is easier, albeit not without issues.
      // However, until the optional locator/suffix, we can essentially move
      // linearly through the character stream.
      if (next === CHAR.HYPHEN) {
        parts.push(ctx.elt(NODES.AUTHORFLAG, i, ++i))
      }

      // We know that the next character is an @
      parts.push(ctx.elt(NODES.AT, i, ++i))

      let citekeyStart = i

      // Now we essentially just swallow every allowed character for the citekey.
      if (ctx.char(i) === CHAR.CURLY_OPEN) {
        citekeyStart++
        parts.push(ctx.elt(NODES.MARK, i, ++i))
        while (i < ctxEndPos && ctx.char(i) !== CHAR.CURLY_CLOSE) {
          if (/\s/u.test(String.fromCharCode(ctx.char(i)))) return -1
          i++
        }

        if (ctx.char(i) !== CHAR.CURLY_CLOSE || i === citekeyStart) {
          return -1 // Curly bracket didn't close
        }

        parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
        citekeysFound++
        parts.push(ctx.elt(NODES.MARK, i, ++i))
      } else {
        const key = BARE_CITATION_KEY.exec(ctx.slice(i, ctxEndPos))?.[0]
        if (key === undefined) return -1
        i += key.length

        // Note that we need not check for whether i = ctxEndPos, since the
        // citation is allowed to be the last thing within the inline context.
        parts.push(ctx.elt(NODES.KEY, citekeyStart, i))
        citekeysFound++
      }

      // At this point we are guaranteed to have a citekey. Next, check if there
      // is a locator/suffix bracket. Must be separated from the citekey by a
      // space, and must not start a new bracketed citation (e.g. `[@...]` or `[-@...]`).
      const hasBracket = i < ctxEndPos - 1 && ctx.char(i) === CHAR.SPACE && ctx.char(i + 1) === CHAR.BRACKET_OPEN
      const isBracketedCitation = hasBracket && (
        ctx.char(i + 2) === CHAR.AT ||
        (ctx.char(i + 2) === CHAR.HYPHEN && ctx.char(i + 3) === CHAR.AT)
      )
      if (hasBracket && !isBracketedCitation) {
        // Yes, there seems to be a locator bracket.

        // Remember the end of the citekey if the bracket turns out to not be
        // closed, so we can reset i and the citation element will be correct.
        const citekeyEnd = i

        // In this branch, we only temporarliy collect all elements, since we do
        // not yet know if the bracket actually closes. If it doesn't, anything
        // until the citekey is still valid, but the rest must be thrown away.
        const temporaryParts: MDElement[] = []

        i++
        temporaryParts.push(ctx.elt(NODES.MARK, i, ++i))
        let intextSuffixStart = i

        // Does the remaining slice start with an explicit locator label?
        let locatorStart = -1
        const slice = ctx.slice(i, i + maxLocatorLabelLength + 1)
        const lclocIndex = slice.indexOf(' ')
        const lcloc = slice.substring(0, lclocIndex).toLowerCase()
        // The label must be followed by a space, so `lclocIndex` must be greater than 0
        const explicitLabel = lclocIndex > 0 && allValidLocatorLabels.has(lcloc) ? lcloc : undefined

        if (explicitLabel !== undefined) {
          locatorStart = i
          // Move i forward until after the space so that the implicit locator
          // logic can take over
          i += explicitLabel.length + 1
        } else if (((ctx.char(i) >= 48 && ctx.char(i) <= 57) || ROMAN_NUMERAL_CODES.includes(ctx.char(i)))) {
          // Found a valid locator character -> begin implicit locator
          locatorStart = i
        }

        if (locatorStart > -1) {
          // There was an implicit or explicit locator; so now we just have to
          // move i forward until no more valid locator chars exist
          while (i < ctxEndPos && ((ctx.char(i) >= 48 && ctx.char(i) <= 57) || ROMAN_NUMERAL_CODES.includes(ctx.char(i)) || ctx.char(i) === CHAR.HYPHEN || ctx.char(i) === CHAR.DOT)) {
            i++
          }

          temporaryParts.push(ctx.elt(NODES.LOCATOR, locatorStart, i))
          intextSuffixStart = i
        } // Else: No locator, so essentially everything is suffix.

        // Finally, we just have to find the closing bracket to complete the
        // inline suffix.
        let bracketDepth = 1
        while (i < ctxEndPos) {
          if (ctx.char(i) === CHAR.BRACKET_OPEN) bracketDepth++
          if (ctx.char(i) === CHAR.BRACKET_CLOSE) bracketDepth--
          if (bracketDepth === 0) break
          i++
        }

        if (ctx.char(i) === CHAR.BRACKET_CLOSE) {
          // First, commit the temporary collected parts ...
          parts.push(...temporaryParts)
          // ... add the suffix (intextSuffixStart is sensitive to locator) ...
          if (intextSuffixStart < i) {
            parts.push(ctx.elt(NODES.SUFFIX, intextSuffixStart, i))
          }
          // ... and close off with the close marker
          parts.push(ctx.elt(NODES.MARK, i, ++i))
        } else {
          // Bracket did not actually close -> reset i
          i = citekeyEnd
        }
      } // else: No locator/suffix bracket, keep the found citekey.
    }

    // Essentially, this `if` branch requires that a valid citation must have
    // at least one part and at least one citekey. This is just a final sanity
    // check as otherwise bracketed text would be considered a citation. In
    // several parts of the code we assume that a citation MUST have at least
    // one citekey.
    if (parts.length > 0 && citekeysFound > 0) {
      if (next === CHAR.BRACKET_OPEN) {
        // Pandoc dispatches `[` as note <|> cite <|> bracketedSpan <|> ... .
        // Once `normalCite` succeeds, this authored bracket cannot later act
        // as the opener of an enclosing span in the Lezer delimiter stack.
        ctx.discardLinkCompanionDelimiters(pos, pos + 1)
      }
      // Final step: Compose the full citation element.
      return ctx.addElement(ctx.elt(NODES.CITATION, pos, i, parts))
    } else {
      return -1
    }
  }
}

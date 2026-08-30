/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc AST Citation Extractor
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Extracts official Pandoc Cite elements and citation items
 *                  directly from Pandoc JSON AST with robust range resolution,
 *                  balanced delimiter handling, and CSL locator decomposition.
 *
 * END HEADER
 */

import { type SourceRange, referenceFamilyOf } from '../../types/common/references'
import {
  type CiteItem,
  type CSL_LOCATOR_TERM,
  ALL_VALID_LOCATOR_LABELS,
  SANITIZED_LOCATOR_LABELS
} from '../modules/markdown-editor/parser/citation-parser'

export interface PandocCitationItem extends CiteItem {
  id: string
  mode: 'NormalCitation' | 'AuthorInText' | 'SuppressAuthor'
  noteNum?: number
  hash?: number
}

export interface PandocExtractedCitation {
  range: SourceRange
  source: string
  composite: boolean
  items: PandocCitationItem[]
}

interface PandocCiteObject {
  citationId: string
  citationPrefix?: unknown[]
  citationSuffix?: unknown[]
  citationMode?: { t: 'NormalCitation' | 'AuthorInText' | 'SuppressAuthor' }
  citationNoteNum?: number
  citationHash?: number
}

function stringifyInlines (inlines: unknown[]): string {
  if (!Array.isArray(inlines)) {
    return ''
  }
  let result = ''
  for (const node of inlines) {
    if (typeof node === 'object' && node !== null && 't' in node) {
      const elt = node as { t: string, c?: unknown }
      if (elt.t === 'Str' && typeof elt.c === 'string') {
        result += elt.c
      } else if (elt.t === 'Space') {
        result += ' '
      } else if (elt.t === 'SoftBreak' || elt.t === 'LineBreak') {
        result += '\n'
      } else if (elt.t === 'Code' && Array.isArray(elt.c) && typeof elt.c[1] === 'string') {
        result += '`' + elt.c[1] + '`'
      } else if (elt.t === 'Math' && Array.isArray(elt.c) && typeof elt.c[1] === 'string') {
        result += '$' + elt.c[1] + '$'
      } else if (Array.isArray(elt.c)) {
        result += stringifyInlines(elt.c)
      }
    }
  }
  return result
}

const CANONICAL_ROMAN_NUMERAL = /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i

function isRomanNumeralToken (token: string): boolean {
  const parts = token.split('-')
  return parts.every(part => CANONICAL_ROMAN_NUMERAL.test(part))
}

/**
 * Parses a raw suffix string into structured CSL locator, label, and extra suffix text.
 */
export function cleanSuffix (raw: string | undefined): { suffix?: string, locator?: string, label?: CSL_LOCATOR_TERM } {
  if (raw === undefined || raw.trim() === '') {
    return {}
  }
  let text = raw.replace(/\u00a0/g, ' ').trim()
  if (text.startsWith(',')) {
    text = text.slice(1).trim()
  }
  if (text === '') {
    return {}
  }

  const spaceIndex = text.indexOf(' ')
  const firstWord = (spaceIndex > 0 ? text.slice(0, spaceIndex) : text).toLowerCase()

  if (ALL_VALID_LOCATOR_LABELS.has(firstWord) && spaceIndex > 0) {
    const remainder = text.slice(spaceIndex + 1).trim()
    const digitMatch = /^[0-9]+(?:-[0-9]+)?(?:\.[0-9]+)*/.exec(remainder)
    const romanMatch = /^[ivxlcdm]+(?:-[ivxlcdm]+)*/i.exec(remainder)
    const locToken = digitMatch ? digitMatch[0] : (romanMatch && isRomanNumeralToken(romanMatch[0]) ? romanMatch[0] : null)

    if (locToken !== null) {
      let label: CSL_LOCATOR_TERM | undefined
      for (const [key, values] of Object.entries(SANITIZED_LOCATOR_LABELS)) {
        if (values.has(firstWord)) {
          label = key as CSL_LOCATOR_TERM
          break
        }
      }
      const extraSuffix = remainder.slice(locToken.length).trim()
      return { locator: locToken, label, suffix: extraSuffix === '' ? undefined : extraSuffix }
    }
  }

  // Implicit numeric locator: digits
  const digitMatch = /^[0-9]+(?:-[0-9]+)?(?:\.[0-9]+)*/.exec(text)
  if (digitMatch !== null) {
    const locator = digitMatch[0]
    const extraSuffix = text.slice(digitMatch[0].length).trim()
    return { locator, label: 'page', suffix: extraSuffix === '' ? undefined : extraSuffix }
  }

  // Implicit Roman numeral locator: only if token is valid canonical Roman numeral and followed by non-letter
  const romanMatch = /^[ivxlcdm]+(?:-[ivxlcdm]+)*/i.exec(text)
  if (romanMatch !== null && isRomanNumeralToken(romanMatch[0])) {
    const after = text[romanMatch[0].length]
    if (after === undefined || !/[A-Za-z]/.test(after)) {
      const locator = romanMatch[0]
      const extraSuffix = text.slice(romanMatch[0].length).trim()
      return { locator, label: 'page', suffix: extraSuffix === '' ? undefined : extraSuffix }
    }
  }

  return { suffix: text }
}

/**
 * Searches for a balanced bracket enclosure `[...]` containing `keyPos`.
 */
function findBalancedBracketEnclosure (markdown: string, keyPos: number, minOffset: number): { from: number, to: number } | null {
  // Find outermost opening bracket before keyPos
  let open = -1
  let depth = 0
  for (let i = keyPos - 1; i >= minOffset; i--) {
    if (markdown[i] === ']') {
      depth++
    } else if (markdown[i] === '[') {
      if (depth === 0) {
        open = i
        break
      }
      depth--
    } else if (markdown[i] === '\n' && i > 0 && markdown[i - 1] === '\n') {
      break
    }
  }

  if (open === -1) {
    return null
  }

  // Find matching closing bracket
  depth = 1
  for (let i = open + 1; i < markdown.length; i++) {
    if (markdown[i] === '[') {
      depth++
    } else if (markdown[i] === ']') {
      depth--
      if (depth === 0) {
        // keyPos MUST be strictly inside [open, i + 1]
        if (open <= keyPos && keyPos < i + 1) {
          return { from: open, to: i + 1 }
        }
        return null
      }
    }
  }

  return null
}

interface RawASTCite {
  citeObjects: PandocCiteObject[]
  fallbackText: string
}

/**
 * Extracts all Cite elements from a Pandoc JSON AST tree and resolves exact document ranges.
 */
export function extractCitationsFromPandocAST (ast: unknown, markdown: string): PandocExtractedCitation[] {
  const rawCites: RawASTCite[] = []

  function walk (node: unknown): void {
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child)
      }
      return
    }

    if (typeof node !== 'object' || node === null) {
      return
    }

    const obj = node as Record<string, unknown>

    if (obj.t === 'Cite' && Array.isArray(obj.c) && obj.c.length >= 2) {
      const citeObjects = obj.c[0] as PandocCiteObject[]
      const fallbackInlines = obj.c[1] as unknown[]
      const fallbackText = stringifyInlines(fallbackInlines)

      rawCites.push({
        citeObjects,
        fallbackText
      })
    }

    for (const key of Object.keys(obj)) {
      walk(obj[key])
    }
  }

  walk(ast)

  const extracted: PandocExtractedCitation[] = []
  let searchOffset = 0

  for (const raw of rawCites) {
    const { citeObjects, fallbackText } = raw
    if (citeObjects.length === 0) {
      continue
    }

    // Check for compound crossref + citation group: e.g. @def-core [@nlab:item]
    const hasLeadingCrossref = referenceFamilyOf(citeObjects[0].citationId) !== undefined &&
      citeObjects[0].citationMode?.t === 'AuthorInText'
    const hasSubsequentNormal = citeObjects.slice(1).some(c =>
      c.citationMode?.t === 'NormalCitation' || referenceFamilyOf(c.citationId) === undefined
    )

    if (hasLeadingCrossref && hasSubsequentNormal && citeObjects.length > 1) {
      const crossrefObj = citeObjects[0]
      const bracketedObjs = citeObjects.slice(1)

      const crossrefKey = '@' + crossrefObj.citationId
      const crossrefPos = markdown.indexOf(crossrefKey, searchOffset)

      if (crossrefPos !== -1) {
        const crossrefFrom = crossrefPos > 0 && markdown[crossrefPos - 1] === '-' ? crossrefPos - 1 : crossrefPos
        const crossrefTo = crossrefPos + crossrefKey.length
        extracted.push({
          range: { from: crossrefFrom, to: crossrefTo },
          source: markdown.slice(crossrefFrom, crossrefTo),
          composite: true,
          items: [{
            id: crossrefObj.citationId,
            mode: 'AuthorInText'
          }]
        })
        searchOffset = crossrefTo
      }

      const secondKey = '@' + bracketedObjs[0].citationId
      const secondPos = markdown.indexOf(secondKey, searchOffset)
      if (secondPos !== -1) {
        const bracketRange = findBalancedBracketEnclosure(markdown, secondPos, searchOffset)
        const from = bracketRange ? bracketRange.from : (secondPos > 0 && markdown[secondPos - 1] === '-' ? secondPos - 1 : secondPos)
        const to = bracketRange ? bracketRange.to : secondPos + secondKey.length

        const bracketItems: PandocCitationItem[] = bracketedObjs.map(c => {
          const mode = c.citationMode?.t ?? 'NormalCitation'
          const prefixRaw = c.citationPrefix ? stringifyInlines(c.citationPrefix).trim() : undefined
          const prefix = prefixRaw === '' ? undefined : prefixRaw?.replace(/\u00a0/g, ' ')
          const suffixRaw = c.citationSuffix ? stringifyInlines(c.citationSuffix) : undefined
          const { suffix, locator, label } = cleanSuffix(suffixRaw)

          return {
            id: c.citationId,
            prefix,
            suffix,
            locator,
            label,
            mode,
            'suppress-author': mode === 'SuppressAuthor' ? true : undefined,
            noteNum: c.citationNoteNum,
            hash: c.citationHash
          }
        })

        extracted.push({
          range: { from, to },
          source: markdown.slice(from, to),
          composite: false,
          items: bracketItems
        })
        searchOffset = to
      }
      continue
    }

    // Standard single or multi-item cluster
    const items: PandocCitationItem[] = []
    let composite = false

    for (let i = 0; i < citeObjects.length; i++) {
      const cite = citeObjects[i]
      const mode = cite.citationMode?.t ?? 'NormalCitation'
      if (mode === 'AuthorInText') {
        composite = true
      }

      const prefixRaw = cite.citationPrefix ? stringifyInlines(cite.citationPrefix).trim() : undefined
      const prefixText = prefixRaw === '' ? undefined : prefixRaw?.replace(/\u00a0/g, ' ')
      const suffixRaw = cite.citationSuffix ? stringifyInlines(cite.citationSuffix) : undefined
      const { suffix: cleanedSuffix, locator, label } = cleanSuffix(suffixRaw)

      items.push({
        id: cite.citationId,
        prefix: prefixText,
        suffix: cleanedSuffix,
        locator,
        label,
        mode: cite.citationMode?.t ?? (composite && i === 0 ? 'AuthorInText' : 'NormalCitation'),
        'suppress-author': mode === 'SuppressAuthor' ? true : undefined,
        noteNum: cite.citationNoteNum,
        hash: cite.citationHash
      })
    }

    let from = -1
    let to = -1
    let rawSource = fallbackText

    // 1. Direct fallback text match if exact and without nested markup
    const directIndex = fallbackText !== '' ? markdown.indexOf(fallbackText, searchOffset) : -1
    if (directIndex !== -1 && !fallbackText.includes('*') && !fallbackText.includes('`') && !fallbackText.includes('$')) {
      from = directIndex
      if (items[0].mode === 'SuppressAuthor' && from > 0 && markdown[from - 1] === '-') {
        from = from - 1
      }
      to = directIndex + fallbackText.length
      rawSource = markdown.slice(from, to)
    } else {
      // 2. Structured key and bracket enclosure search
      const firstKey = '@' + items[0].id
      let keyPos = markdown.indexOf(firstKey, searchOffset)

      while (keyPos !== -1 && (markdown[keyPos - 1] === '`' || (keyPos > 1 && markdown[keyPos - 2] === '`'))) {
        keyPos = markdown.indexOf(firstKey, keyPos + firstKey.length)
      }

      if (keyPos !== -1) {
        if (composite) {
          from = keyPos > 0 && markdown[keyPos - 1] === '-' ? keyPos - 1 : keyPos
          to = keyPos + firstKey.length
          if (to < markdown.length && markdown[to] === ' ' && markdown[to + 1] === '[') {
            const bracketRange = findBalancedBracketEnclosure(markdown, to + 2, to + 1)
            if (bracketRange) {
              to = bracketRange.to
            }
          }
        } else {
          const bracketRange = findBalancedBracketEnclosure(markdown, keyPos, searchOffset)
          if (bracketRange) {
            from = bracketRange.from
            to = bracketRange.to
          } else {
            from = keyPos > 0 && markdown[keyPos - 1] === '-' ? keyPos - 1 : keyPos
            to = keyPos + firstKey.length
          }
        }
        rawSource = markdown.slice(from, to)
      }
    }

    if (from !== -1 && to !== -1) {
      searchOffset = to
      extracted.push({
        range: { from, to },
        source: rawSource,
        composite,
        items
      })
    }
  }

  extracted.sort((a, b) => a.range.from - b.range.from)
  return extracted
}

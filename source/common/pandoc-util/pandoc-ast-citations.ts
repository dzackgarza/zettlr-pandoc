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
 *                  directly from Pandoc JSON AST with exact source character ranges.
 *
 * END HEADER
 */

import { type SourceRange } from '../../types/common/references'
import { type CiteItem } from '../modules/markdown-editor/parser/citation-parser'

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
      } else if (Array.isArray(elt.c)) {
        result += stringifyInlines(elt.c)
      }
    }
  }
  return result
}

function cleanSuffix (raw: string | undefined): { suffix?: string, locator?: string } {
  if (raw === undefined || raw.trim() === '') {
    return {}
  }
  let text = raw.replace(/\u00a0/g, ' ').trim()
  if (text.startsWith(',')) {
    text = text.slice(1).trim()
  }
  return { suffix: text }
}

/**
 * Extracts all Cite elements from a Pandoc JSON AST tree.
 */
export function extractCitationsFromPandocAST (ast: unknown, markdown: string): PandocExtractedCitation[] {
  const results: PandocExtractedCitation[] = []
  let searchOffset = 0

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

      const items: PandocCitationItem[] = []
      let composite = false

      for (const cite of citeObjects) {
        const mode = cite.citationMode?.t ?? 'NormalCitation'
        if (mode === 'AuthorInText') {
          composite = true
        }

        const prefixRaw = cite.citationPrefix ? stringifyInlines(cite.citationPrefix).trim() : undefined
        const prefixText = prefixRaw === '' ? undefined : prefixRaw?.replace(/\u00a0/g, ' ')
        const suffixRaw = cite.citationSuffix ? stringifyInlines(cite.citationSuffix) : undefined
        const { suffix: cleanedSuffix } = cleanSuffix(suffixRaw)

        items.push({
          id: cite.citationId,
          prefix: prefixText,
          suffix: cleanedSuffix,
          mode,
          'suppress-author': mode === 'SuppressAuthor' ? true : undefined,
          noteNum: cite.citationNoteNum,
          hash: cite.citationHash
        })
      }

      let from = -1
      let to = -1
      let rawSource = fallbackText

      // 1. Try exact match of fallbackText from searchOffset
      const directIndex = fallbackText !== '' ? markdown.indexOf(fallbackText, searchOffset) : -1
      if (directIndex !== -1) {
        from = directIndex
        to = directIndex + fallbackText.length
        rawSource = fallbackText
      } else if (items.length > 0) {
        // 2. Fallback key search
        const firstKey = '@' + items[0].id
        const keyPos = markdown.indexOf(firstKey, searchOffset)
        if (keyPos !== -1) {
          if (composite) {
            from = keyPos > 0 && markdown[keyPos - 1] === '-' ? keyPos - 1 : keyPos
            to = keyPos + firstKey.length
            if (to < markdown.length && markdown[to] === ' ' && markdown[to + 1] === '[') {
              const closeBracket = markdown.indexOf(']', to + 1)
              if (closeBracket !== -1) {
                to = closeBracket + 1
              }
            }
          } else {
            const openBracket = markdown.lastIndexOf('[', keyPos)
            if (openBracket >= 0 && (searchOffset === 0 || openBracket >= searchOffset - 1)) {
              from = openBracket
              const closeBracket = markdown.indexOf(']', keyPos)
              if (closeBracket !== -1) {
                to = closeBracket + 1
              }
            } else {
              from = keyPos
              to = keyPos + firstKey.length
            }
          }
          rawSource = markdown.slice(from, to)
        }
      }

      if (from !== -1 && to !== -1) {
        searchOffset = to
        results.push({
          range: { from, to },
          source: rawSource,
          composite,
          items
        })
      }
    }

    for (const key of Object.keys(obj)) {
      walk(obj[key])
    }
  }

  walk(ast)
  return results
}

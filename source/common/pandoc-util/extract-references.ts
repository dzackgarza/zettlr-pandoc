/**
 * Extracts the reference surface (definitions and occurrences) of a single
 * markdown document into a typed snapshot (issue #1).
 *
 * This module runs in both the main process (FSAL saved snapshots) and the
 * renderer (live buffer replacement), so it must stay renderer-safe: no Node
 * built-ins and no CodeMirror imports.
 */

import { markdownToAST } from '../modules/markdown-utils'
import type { ASTNode, FencedCode, Heading, PandocDiv } from '../modules/markdown-utils/markdown-ast'
import { parsePandocAttributes, type ParsedPandocAttributes } from './parse-pandoc-attributes'
import { isReferenceableDivClass } from '../util/pandoc-quick-reference'
import {
  CROSSREF_FAMILIES,
  THEOREM_FAMILIES,
  referenceFamilyOf,
  type DocumentReferenceSnapshot,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type SourceRange
} from '../../types/common/references'

/**
 * Computes the deterministic content hash used to key reference snapshots
 * and to gate workspace edits. FNV-1a (32 bit) over UTF-16 code units:
 * dependency-free and identical in main and renderer processes.
 *
 * @param   {string}  markdown  The full markdown source
 *
 * @return  {string}            The hash, e.g. 'fnv1a-811c9dc5'
 */
export function hashDocumentSource (markdown: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < markdown.length; i++) {
    hash ^= markdown.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'fnv1a-' + (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * An authored `{…}` attribute block, located at an exact document offset,
 * with the full (colon-preserving) id token recovered from the authored text.
 */
export interface LocatedAttribute {
  /** The full authored id (parsePandocAttributes truncates ids at colons) */
  key: string
  /** The exact range of the id token including its `#` sigil */
  range: SourceRange
  /** The parsed attribute block (classes and properties) */
  attributes: ParsedPandocAttributes
}

/**
 * Parses an authored attribute block and recovers the full id token. The
 * shared attribute parser stops ids at the first colon, so the token is
 * re-anchored on the parser's own id match and extended over the authored
 * characters up to whitespace or the closing brace.
 *
 * This is the single id-token locator (review B6): reference-lint imports it
 * instead of keeping a parallel copy. It fails LOUD on an inconsistent
 * attribute block (an id the parser reported but the authored text does not
 * contain is a parser bug, not an authorable state) — callers must not
 * downgrade that into a silent skip.
 *
 * @param   {string}  attrText  The authored `{…}` substring
 * @param   {number}  offset    The document offset of the substring
 *
 * @return  {LocatedAttribute|undefined}  The located id, if one is authored
 */
export function locateAttribute (attrText: string, offset: number): LocatedAttribute|undefined {
  const attributes = parsePandocAttributes(attrText)
  if (attributes.id === undefined) {
    return undefined
  }

  const idStart = attrText.indexOf('#' + attributes.id)
  if (idStart === -1) {
    throw new Error(`Inconsistent attribute block: id "${attributes.id}" not found in "${attrText}"`)
  }

  let idEnd = idStart + 1 + attributes.id.length
  while (idEnd < attrText.length && !' \t\n}'.includes(attrText[idEnd])) {
    idEnd++
  }

  return {
    key: attrText.slice(idStart + 1, idEnd),
    range: { from: offset + idStart, to: offset + idEnd },
    attributes
  }
}

/**
 * Returns the ordered child nodes of any AST node (lists, tables, and table
 * rows keep their children under dedicated properties).
 *
 * @param   {ASTNode}  node  The node
 *
 * @return  {ASTNode[]}      The children in document order
 */
function childrenOf (node: ASTNode): ASTNode[] {
  if ('children' in node) {
    return node.children
  } else if ('items' in node) {
    return node.items
  } else if ('rows' in node) {
    return node.rows
  } else if ('cells' in node) {
    return node.cells
  }

  return []
}

/**
 * Returns the alt text of the first image descendant, used as the title of
 * figure definitions.
 *
 * @param   {ASTNode}  node  The subtree to search
 *
 * @return  {string|undefined}  The alt text, if an image exists
 */
function firstImageAlt (node: ASTNode): string|undefined {
  if (node.type === 'Image') {
    return node.alt.value
  }

  for (const child of childrenOf(node)) {
    const alt = firstImageAlt(child)
    if (alt !== undefined) {
      return alt
    }
  }

  return undefined
}

/**
 * Returns the offset of the first character of the line containing pos.
 */
function lineStart (markdown: string, pos: number): number {
  return markdown.lastIndexOf('\n', pos) + 1
}

/**
 * Returns the complete authored line containing pos (without the newline).
 */
function lineAt (markdown: string, pos: number): string {
  const end = markdown.indexOf('\n', pos)
  return markdown.slice(lineStart(markdown, pos), end === -1 ? markdown.length : end)
}

/**
 * Returns the heading text without its trailing attribute block, i.e. the
 * text used for section titles and `enclosingSection`.
 *
 * @param   {Heading}  node  The heading node
 *
 * @return  {string}         The clean heading text
 */
function headingText (node: Heading): string {
  if (Object.keys(node.attributes).length > 0 && node.content.endsWith('}')) {
    const brace = node.content.lastIndexOf('{')
    if (brace !== -1) {
      return node.content.slice(0, brace).trim()
    }
  }

  return node.content.trim()
}

/**
 * Extracts every supported reference definition and occurrence from the
 * given document, in document order, with exact authored ranges.
 *
 * @param   {string}  documentPath  The document's path (snapshot identity)
 * @param   {string}  markdown      The full markdown source
 *
 * @return  {DocumentReferenceSnapshot}  The typed reference snapshot
 */
export function extractReferences (documentPath: string, markdown: string): DocumentReferenceSnapshot {
  return extractReferencesFromAST(documentPath, markdown, markdownToAST(markdown))
}

/**
 * Same extraction as extractReferences(), but over an already-parsed AST of
 * exactly the given markdown source. This is the seam for callers (FSAL's
 * file parser) that already hold the document's AST from a shared parse pass
 * and must not parse twice; both entry points produce identical snapshots.
 *
 * @param   {string}   documentPath  The document's path (snapshot identity)
 * @param   {string}   markdown      The full markdown source the AST was
 *                                   parsed from (ranges and hash source)
 * @param   {ASTNode}  ast           The parsed AST of that exact source
 *
 * @return  {DocumentReferenceSnapshot}  The typed reference snapshot
 */
export function extractReferencesFromAST (documentPath: string, markdown: string, ast: ASTNode): DocumentReferenceSnapshot {
  const sourceHash = hashDocumentSource(markdown)
  const definitions: ReferenceDefinition[] = []
  const occurrences: ReferenceOccurrence[] = []
  // The clean text of the nearest preceding heading during the walk
  let currentSection: string|undefined

  const pushDefinition = (
    located: LocatedAttribute,
    sourceKind: ReferenceDefinition['sourceKind'],
    title: string|undefined,
    previewSource: string
  ): void => {
    const family = referenceFamilyOf(located.key)
    if (family === undefined) {
      // Structurally not a definition: empty key or unsupported family.
      return
    }

    definitions.push({
      key: located.key,
      family,
      sourceKind,
      documentPath,
      range: located.range,
      classes: located.attributes.classes ?? [],
      title,
      previewSource,
      enclosingSection: currentSection,
      sourceHash
    })
  }

  const visitHeading = (node: Heading): void => {
    const slice = markdown.slice(node.from, node.to)
    const brace = typeof node.attributes.id === 'string' && node.attributes.id !== ''
      ? slice.lastIndexOf('{')
      : -1
    if (brace !== -1) {
      const located = locateAttribute(slice.slice(brace), node.from + brace)
      if (located !== undefined) {
        const title = headingText(node)
        pushDefinition(
          located, 'crossref-attr',
          title === '' ? undefined : title,
          lineAt(markdown, located.range.from)
        )
      }
    }

    currentSection = headingText(node)
  }

  /**
   * The caption paragraph of a pandoc-crossref wrapping div: the last child
   * block that is prose — not a fence line, not a code block, and without an
   * image descendant. Subfigure groups author it below the images; wrapped
   * listings author it above the code block.
   */
  const wrappingDivCaption = (node: PandocDiv): string|undefined => {
    const children = childrenOf(node)
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child.type === 'FencedCode' || firstImageAlt(child) !== undefined) {
        continue
      }
      const text = markdown.slice(child.from, child.to).trim()
      if (text === '' || /^:{3,}/.test(text)) {
        continue // Empty inter-block runs and the div's own fence lines
      }
      return text
    }
    return undefined
  }

  const firstChildHeadingText = (node: PandocDiv): string|undefined => {
    for (const child of childrenOf(node)) {
      if (child.type === 'Heading') {
        const title = headingText(child as Heading)
        return title === '' ? undefined : title
      }
    }
    return undefined
  }

  const visitPandocDiv = (node: PandocDiv): void => {
    const openLineEnd = markdown.indexOf('\n', node.from)
    const openLine = markdown.slice(node.from, openLineEnd === -1 || openLineEnd > node.to ? node.to : openLineEnd)
    const brace = openLine.indexOf('{')
    if (brace === -1) {
      return
    }

    const located = locateAttribute(openLine.slice(brace), node.from + brace)
    if (located === undefined) {
      return
    }

    // Theorem-like divs define targets through their class registry;
    // proof-like and other non-referenceable div classes never do.
    const classes = located.attributes.classes ?? []
    const isProofLike = classes.some(divClass => {
      const lower = divClass.toLowerCase()
      return lower === 'proof' || lower === 'sketch' || lower === 'solution'
    })
    if (isProofLike) {
      return
    }

    const theoremTitle = located.attributes.properties?.title ??
      located.attributes.properties?.name ??
      firstChildHeadingText(node)

    if (classes.some(isReferenceableDivClass)) {
      pushDefinition(
        located, 'theorem-div',
        theoremTitle,
        markdown.slice(lineStart(markdown, node.from), node.to)
      )
      return
    }

    // pandoc-crossref wrapping/subfigure forms (issue #1, review A1) and
    // Quarto classless theorem divs (::: {#def-core}, ::: {#thm-main}):
    const family = referenceFamilyOf(located.key)
    if (family !== undefined) {
      if ((CROSSREF_FAMILIES as readonly string[]).includes(family)) {
        pushDefinition(
          located, 'crossref-attr',
          located.attributes.properties?.title ?? located.attributes.properties?.name ?? wrappingDivCaption(node),
          markdown.slice(lineStart(markdown, node.from), node.to)
        )
      } else if ((THEOREM_FAMILIES as readonly string[]).includes(family)) {
        pushDefinition(
          located, 'theorem-div',
          theoremTitle,
          markdown.slice(lineStart(markdown, node.from), node.to)
        )
      }
    }
  }

  const visitFencedCode = (node: FencedCode): void => {
    if (!node.info.startsWith('{')) {
      return
    }

    const infoOffset = markdown.slice(node.from, node.to).indexOf(node.info)
    if (infoOffset === -1) {
      throw new Error(`Inconsistent fenced code node: info string not found in [${node.from},${node.to}]`)
    }

    const located = locateAttribute(node.info, node.from + infoOffset)
    if (located !== undefined) {
      pushDefinition(
        located, 'crossref-attr',
        located.attributes.properties?.caption,
        markdown.slice(lineStart(markdown, node.from), node.to)
      )
    }
  }

  // Handles attributes the parser attached to an enclosing block (table
  // caption lines, display math paragraphs, image paragraphs): the attribute
  // block trails the structure, so it is the last brace group of the node's
  // own slice.
  const visitAttributedBlock = (node: ASTNode): void => {
    if (typeof node.attributes.id !== 'string' || node.attributes.id === '') {
      return
    }

    const slice = markdown.slice(node.from, node.to)
    const brace = slice.lastIndexOf('{')
    if (brace === -1) {
      throw new Error(`Inconsistent attributed node: no attribute block in [${node.from},${node.to}]`)
    }

    const located = locateAttribute(slice.slice(brace), node.from + brace)
    if (located === undefined) {
      return
    }

    const family = referenceFamilyOf(located.key)
    let title: string|undefined
    if (family === 'fig') {
      title = firstImageAlt(node)
    } else if (family === 'tbl') {
      // A table caption line is authored as `: Caption {#tbl:key}`
      const caption = slice.slice(0, brace).trim()
      if (caption.startsWith(':')) {
        title = caption.slice(1).trim()
      }
    }

    pushDefinition(located, 'crossref-attr', title, lineAt(markdown, located.range.from))
  }

  const visit = (node: ASTNode): void => {
    switch (node.type) {
      case 'Heading':
        visitHeading(node)
        break
      case 'PandocDiv':
        visitPandocDiv(node)
        break
      case 'FencedCode':
        visitFencedCode(node)
        break
      case 'Citation': {
        const cluster = node.value
        const syntaxKind = cluster.startsWith('[') ? 'bracketed' : 'bare'
        let searchFrom = 0
        for (const item of node.parsedCitation.items) {
          const family = referenceFamilyOf(item.id)
          if (family === undefined) {
            // Bibliography citations (e.g. @Ols04) are never occurrences.
            continue
          }

          const token = '@' + item.id
          const idx = cluster.indexOf(token, searchFrom)
          if (idx === -1) {
            throw new Error(`Inconsistent citation node: item "${item.id}" not found in "${cluster}"`)
          }
          searchFrom = idx + token.length

          occurrences.push({
            key: item.id,
            family,
            range: { from: node.from + idx, to: node.from + idx + token.length },
            syntaxKind,
            clusterRaw: cluster,
            documentPath,
            sourceHash
          })
        }
        break
      }
      default:
        visitAttributedBlock(node)
    }

    for (const child of childrenOf(node)) {
      visit(child)
    }
  }

  visit(ast)

  return { documentPath, sourceHash, definitions, occurrences }
}

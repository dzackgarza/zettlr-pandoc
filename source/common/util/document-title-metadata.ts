import {
  extractASTNodes,
  extractTextnodes,
  markdownToAST
} from '@common/modules/markdown-utils'
import type { ASTNode, Heading } from '@common/modules/markdown-utils/markdown-ast'

export interface DocumentTitleMetadata {
  firstHeading: string|null
  firstSentence: string|null
}

function proseUntilMath (nodes: ASTNode[]): string {
  const parts: string[] = []

  function visit (node: ASTNode): boolean {
    if (node.type === 'Text') {
      parts.push(node.whitespaceBefore + node.value)
      return true
    }

    if (node.type === 'InlineCode') {
      // MathTeX carries a non-empty info marker. Stop rather than concatenating
      // prose from opposite sides of math into an incoherent fallback title.
      return node.info === ''
    }

    if (node.type === 'Link' || node.type === 'Image') {
      parts.push(node.alt.whitespaceBefore + node.alt.value)
      return true
    }

    if (
      node.type === 'Generic' ||
      node.type === 'Emphasis' ||
      node.type === 'Highlight' ||
      node.type === 'Strikethrough' ||
      node.type === 'Superscript' ||
      node.type === 'Subscript' ||
      node.type === 'PandocSpan'
    ) {
      for (const child of node.children) {
        if (!visit(child)) return false
      }
    }

    return true
  }

  for (const node of nodes) {
    if (!visit(node)) break
  }

  return parts.join('').replace(/\s+/gu, ' ').trim()
}

export function documentTitleMetadataFromAST (ast: ASTNode): DocumentTitleMetadata {
  if (ast.type !== 'Document') {
    return { firstHeading: null, firstSentence: null }
  }
  const headings = extractASTNodes(ast, 'Heading') as Heading[]
  const firstHeadingNode = headings.find(heading => {
    if (!heading.name.startsWith('SetextHeading')) {
      return true
    }

    // A standalone '=' inside display math can make Lezer manufacture a
    // Setext H1 spanning the surrounding equation. Legitimate Setext headings
    // may contain inline math, but never a display-math child.
    const hasDisplayMathChild = heading.children.some(child => {
      return child.type === 'InlineCode' && child.info === '$$'
    })
    const extracted = extractTextnodes(heading)
      .map(node => node.whitespaceBefore + node.value)
      .join('')

    return !hasDisplayMathChild && !/(^|\s)\$\$(\s|$)/u.test(extracted)
  })
  const firstHeading = firstHeadingNode === undefined
    ? null
    : titleCandidate(extractTextnodes(firstHeadingNode)
      .map(node => node.whitespaceBefore + node.value)
      .join(''))

  const paragraph = ast.children.find(node => node.type === 'Generic' && node.name === 'Paragraph')
  if (paragraph === undefined || paragraph.type !== 'Generic') {
    return { firstHeading, firstSentence: null }
  }

  const prose = proseUntilMath(paragraph.children)
  if (prose === '') {
    return { firstHeading, firstSentence: null }
  }

  const firstSentence = prose.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? prose
  return { firstHeading, firstSentence: titleCandidate(firstSentence) }
}

/** A heading or sentence that is only whitespace offers no title. */
function titleCandidate (text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

export function documentTitleMetadata (content: string): DocumentTitleMetadata {
  return documentTitleMetadataFromAST(markdownToAST(content))
}

/**
 * Returns the semantic Markdown heading level represented by a Lezer node.
 *
 * Pandoc ATX heading levels are unbounded. HeaderMark width is therefore the
 * authoritative semantic level; the node type deliberately does not encode it.
 */

import type { SyntaxNode } from '@lezer/common'

export function markdownHeadingLevel (node: SyntaxNode): number|null {
  if (node.name === 'SetextHeading1') return 1
  if (node.name === 'SetextHeading2') return 2
  if (node.name !== 'ATXHeading') return null

  const mark = node.getChild('HeaderMark')
  if (mark === null) return null
  const level = mark.to - mark.from
  return level > 0 ? level : null
}

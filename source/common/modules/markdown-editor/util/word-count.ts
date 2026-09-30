/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        countDocument, countRange
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Word and character counts of an editor document. The
 *                  count of a document is the sum of the counts of its
 *                  top-level blocks. The Markdown parser keeps the node
 *                  object of each block that it did not parse again, so the
 *                  count of such a block is known, and a new count reads only
 *                  the blocks that changed.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { parseNode } from '@common/modules/markdown-utils/markdown-ast'
import { countAll } from '@common/util/counter'
import { documentText } from './document-text'

export interface TextCounts {
  words: number
  chars: number
}

interface BlockCounts extends TextCounts {
  locale: string
}

const blockCounts = new WeakMap<Tree, BlockCounts>()

function countBlock (block: SyntaxNode, text: string, locale: string): TextCounts {
  const tree = block.tree
  const known = tree === null ? undefined : blockCounts.get(tree)
  if (known !== undefined && known.locale === locale) {
    return known
  }
  const counts = countAll(parseNode(block, text), locale)
  if (tree !== null) {
    blockCounts.set(tree, { ...counts, locale })
  }
  return counts
}

/** Counts the words and characters of the part of the document that is parsed. */
export function countDocument (state: EditorState, locale: string): TextCounts {
  const text = documentText(state)
  const counts = { words: 0, chars: 0 }
  for (let block = syntaxTree(state).topNode.firstChild; block !== null; block = block.nextSibling) {
    const { words, chars } = countBlock(block, text, locale)
    counts.words += words
    counts.chars += chars
  }
  return counts
}

/** Counts the words and characters between two positions of the document. */
export function countRange (state: EditorState, locale: string, from: number, to: number): TextCounts {
  const text = documentText(state)
  const top = syntaxTree(state).topNode
  if (top.name !== 'Document') {
    // Only the blocks of a Markdown document hold all text of the document.
    return countAll(parseNode(top, text), locale, from, to)
  }

  const counts = { words: 0, chars: 0 }
  for (let block = top.childAfter(from); block !== null && block.from < to; block = block.nextSibling) {
    const whole = block.from >= from && block.to <= to
    const { words, chars } = whole
      ? countBlock(block, text, locale)
      : countAll(parseNode(block, text), locale, from, to)
    counts.words += words
    counts.chars += chars
  }
  return counts
}

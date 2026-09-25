import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { stripMathDelimiters } from '@common/util/math-delimiters'

function nodeIsMath (state: EditorState, node: SyntaxNode|null): boolean {
  while (node !== null) {
    if (
      (node.type.name === 'InlineCode' || node.type.name === 'FencedCode') &&
      stripMathDelimiters(state.sliceDoc(node.from, node.to)) !== null
    ) {
      return true
    }
    node = node.parent
  }
  return false
}

/** True when the cursor is in, or immediately at the end boundary of, parsed math source. */
export function isMathPosition (state: EditorState, pos: number): boolean {
  if (nodeIsMath(state, syntaxTree(state).resolveInner(pos, -1))) {
    return true
  }
  return pos > 0 && nodeIsMath(state, syntaxTree(state).resolveInner(pos - 1, 1))
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RuleRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer displays horizontal rules.
 *
 * END HEADER
 */

import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNodeRef } from '@lezer/common'
import { WidgetType } from '@codemirror/view'

import { type EditorState } from '@codemirror/state'
import { rangeInPreviewSuppression } from '../util/range-in-preview-suppression'

class RuleWidget extends WidgetType {
  eq (_other: RuleWidget): boolean {
    return true
  }

  toDOM (): HTMLElement {
    return document.createElement('hr')
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === 'HorizontalRule'
}

function createWidget (state: EditorState, node: SyntaxNodeRef): RuleWidget|undefined {
  // Horizontal rules must always show their syntax even if the cursor is only
  // adjacent for a proper UX. If we didn't do that, users would have to click
  // within this element to show the heading characters, which is undesirable.
  if (rangeInPreviewSuppression(state, node.from, node.to, true)) {
    return undefined
  }

  return new RuleWidget()
}

export const renderHorizontalRules = [
  renderBlockWidgets([ 'HorizontalRule' ], shouldHandleNode, createWidget)
]

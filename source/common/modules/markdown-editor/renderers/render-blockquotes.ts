/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        renderBlockquotes
 * CVM-Role:        View
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     This renderer adds a vertical bar
 *                  to the left edge of blockquotes
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { Range, RangeSet } from '@codemirror/state'
import { BlockWrapper, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { rangeInPreviewSuppression } from '../util/range-in-preview-suppression'
import type { SyntaxNode } from '@lezer/common'
import { configField } from '../util/configuration'
import { VISUAL_INDENT_EXEMPT_CLASS } from '../plugins/visual-indent'

function showBlockquoteWrappers (view: EditorView): RangeSet<BlockWrapper> {
  const ranges: Range<BlockWrapper>[] = []
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (rangeInPreviewSuppression(view.state, node.from, node.to, includeAdjacent)) {
          return
        }

        if (node.name !== 'Blockquote') {
          return
        }

        let parent: SyntaxNode|null = node.node.parent
        let parentNode

        while (parent) {
          if (parent.name === 'Blockquote') {
            parentNode = parent.node
          }
          parent = parent.parent
        }

        if (parentNode && rangeInPreviewSuppression(view.state, parentNode.from, parentNode.to, includeAdjacent)) {
          return
        }

        const line = view.state.doc.lineAt(node.from)
        const wrapper = BlockWrapper.create({
          tagName: 'blockquote-wrapper',
          attributes: {
            class: `blockquote-wrapper ${VISUAL_INDENT_EXEMPT_CLASS}`,
          }
        })

        ranges.push(wrapper.range(line.from, node.to))
      },
    })
  }

  return BlockWrapper.set(ranges, true)
}

const blockquotePlugin = ViewPlugin.fromClass(class {
  blockWrappers: RangeSet<BlockWrapper>

  constructor (view: EditorView) {
    this.blockWrappers = showBlockquoteWrappers(view)
  }

  update (update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.blockWrappers = showBlockquoteWrappers(update.view)
    }
  }

}, {
  provide: plugin => EditorView.blockWrappers.of(view => view.plugin(plugin)?.blockWrappers as RangeSet<BlockWrapper>|undefined || BlockWrapper.set([]))
})

export const renderBlockquotes = [
  blockquotePlugin,
  EditorView.baseTheme({
    '.blockquote-wrapper': {
      display: 'block',
      borderLeft: 'solid 0.25em',
      paddingLeft: '0.5em',
      marginLeft: '0.25em'
    },
    // The visual-indent line decorations are reverted through the
    // VISUAL_INDENT_EXEMPT_CLASS contract owned by the visual-indent plugin.
    '.blockquote-wrapper .cm-line': {
      opacity: '0.7'
    }
  })
]

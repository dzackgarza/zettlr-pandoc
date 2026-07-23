/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PandocAttributesRenderer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Pandoc attribute blocks ({#id .class key=val}) attach to
 *                  headings, table captions, code blocks, images, and spans.
 *                  They are attribute machinery, not content: when a carrier
 *                  line is rendered, the block is hidden, and it reveals
 *                  again while the cursor is on the line — the same
 *                  reveal-on-cursor semantics the fenced-div renderer applies
 *                  to its open fence, shared through
 *                  rangeInPreviewSuppression and the
 *                  previewModeShowSyntaxWhenCursorIsAdjacent preference read
 *                  from the required editor configuration field.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type Range } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { parsePandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'
import { rangeInPreviewSuppression } from '../util/range-in-preview-suppression'
import { configField } from '../util/configuration'

function hideAttributeBlocks (view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  const hiddenDeco = Decoration.replace({})
  // The reveal-on-cursor behaviour is a user preference, so the configuration
  // is a hard dependency: this plugin is only installed by the renderer
  // aggregate, which the editor always builds alongside configField. Reading
  // the field as required means a state assembled without it reports that
  // wiring defect instead of quietly picking a preference the user never set.
  const includeAdjacent = view.state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter (node) {
        if (node.name !== 'PandocAttribute') {
          return
        }

        // Attribute nodes inside span and div constructs belong to the
        // pandoc div/span renderer, which owns their editing presentation.
        for (let parent = node.node.parent; parent !== null; parent = parent.parent) {
          if (parent.name === 'PandocSpan' || parent.name.startsWith('PandocDiv')) {
            return
          }
        }

        // Only hide blocks that actually parse as Pandoc attributes; a brace
        // group carrying none stays visible as the prose it probably is.
        const parsed = parsePandocAttributes(view.state.sliceDoc(node.from, node.to))
        if (parsed.id === undefined && parsed.classes === undefined && parsed.properties === undefined) {
          return
        }

        // Reveal while the cursor is anywhere on the carrier line: hiding is
        // a line-rendering concern, and cursor-on-line is the editing state.
        const line = view.state.doc.lineAt(node.from)
        if (rangeInPreviewSuppression(view.state, line.from, line.to, includeAdjacent)) {
          return
        }

        // Swallow the run of spaces before the block so hiding leaves no
        // trailing gap after the carrier's text.
        let start = node.from
        while (start > line.from && view.state.sliceDoc(start - 1, start) === ' ') {
          start--
        }

        ranges.push(hiddenDeco.range(start, node.to))
      }
    })
  }

  return Decoration.set(ranges, true)
}

export const renderPandocAttributes = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = hideAttributeBlocks(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = hideAttributeBlocks(update.view)
    }
  }
}, {
  decorations: v => v.decorations
})

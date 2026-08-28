/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Footnote Body Background
 * CVM-Role:        CodeMirror Extension
 * License:         GNU GPL v3
 *
 * Description:     Footnote bodies end wherever their indentation ends, which
 *                  is invisible in the source. This extension tints every line
 *                  the parser counts as part of a footnote body, so a line that
 *                  fell out of the note (say, because its indent was lost)
 *                  shows up immediately as an untinted line.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { Range } from '@codemirror/state'

const footnoteLine = Decoration.line({ class: 'cm-footnote-body' })
const footnoteFirstLine = Decoration.line({ class: 'cm-footnote-body cm-footnote-body-first' })
const footnoteLastLine = Decoration.line({ class: 'cm-footnote-body cm-footnote-body-last' })

function footnoteBodyDecorations (view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FootnoteRef') {
          return
        }

        const firstLine = view.state.doc.lineAt(node.from).number
        const lastLine = view.state.doc.lineAt(node.to).number

        for (let i = firstLine; i <= lastLine; i++) {
          const line = view.state.doc.line(i)
          const deco = i === firstLine
            ? footnoteFirstLine
            : i === lastLine ? footnoteLastLine : footnoteLine
          ranges.push(deco.range(line.from))
        }

        return false // Footnotes do not nest
      }
    })
  }

  return Decoration.set(ranges, true)
}

const footnoteBackgroundPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = footnoteBodyDecorations(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = footnoteBodyDecorations(update.view)
    }
  }
}, { decorations: v => v.decorations })

export const footnoteBackground = [
  footnoteBackgroundPlugin,
  EditorView.baseTheme({
    '.cm-footnote-body': {
      backgroundColor: 'color-mix(in srgb, var(--zettlr-editor-primary-color) 10%, transparent)',
      boxShadow: 'inset 2px 0 0 0 var(--zettlr-editor-primary-color)'
    },
    '.cm-footnote-body-first': {
      borderTopLeftRadius: '4px',
      borderTopRightRadius: '4px'
    },
    '.cm-footnote-body-last': {
      borderBottomLeftRadius: '4px',
      borderBottomRightRadius: '4px'
    }
  })
]

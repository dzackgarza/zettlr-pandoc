/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ figure linter
 * CVM-Role:        Linter
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Marks a raw TikZ block that will not render, following the
 *                  reference-lint archetype (./reference-lint.ts).
 *
 *                  A \begin{tikzcd} written directly under a line of prose is
 *                  a lazy paragraph continuation: Markdown folds it into that
 *                  paragraph, so there is no block of its own for
 *                  render-tikz.ts to replace and the figure silently never
 *                  appears. Pandoc reads the same file as a RawBlock and
 *                  exports the figure regardless, so an export gives the
 *                  author no hint that the editor showed them nothing.
 *
 *                  Whether a paragraph renders is asked of
 *                  rawTikzEnvironment(), the renderer's own predicate, so the
 *                  marker cannot claim one thing while the figure does
 *                  another.
 *
 * END HEADER
 */

import { type Diagnostic } from '@codemirror/lint'
import { linter } from '@codemirror/lint'
import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { rawTikzEnvironment } from '../renderers/render-tikz'

/**
 * An environment opening a line inside a paragraph. Anchored per line, so
 * prose that merely names the environment mid-sentence is not a figure.
 */
const OPEN_LINE_RE = /^\\begin\{(tikzcd|tikzpicture)\}/gm

export function tikzLintSource (view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const state = view.state

  syntaxTree(state).iterate({
    enter (node) {
      if (node.type.name !== 'Paragraph') {
        return
      }
      const text = state.sliceDoc(node.from, node.to)
      // The paragraph IS the figure: it renders, so there is nothing to say.
      if (rawTikzEnvironment(text) !== null) {
        return
      }
      for (const match of text.matchAll(OPEN_LINE_RE)) {
        const line = state.doc.lineAt(node.from + match.index)
        diagnostics.push({
          from: line.from,
          to: line.to,
          severity: 'error',
          message:
            `This \\begin{${match[1]}} is part of the paragraph around it, so the figure will not be drawn. ` +
            'Markdown reads a line written directly under prose as a continuation of it. ' +
            'Put a blank line above the block and below its \\end, and it renders. ' +
            'Pandoc exports the figure either way, so an export will not show this.',
          source: 'tikz-lint'
        })
      }
    }
  })

  return diagnostics
}

export const tikzLint = linter(tikzLintSource)

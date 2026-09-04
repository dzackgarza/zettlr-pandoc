/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LaTeX environment linter
 * CVM-Role:        Linter
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Marks a \begin{…} that Markdown folded into the paragraph
 *                  around it, following the reference-lint archetype
 *                  (./reference-lint.ts).
 *
 *                  A line written directly under prose is a lazy paragraph
 *                  continuation, so an environment written that way is not a
 *                  block of its own. What that costs splits in two, and the
 *                  severities differ because the author needs different things
 *                  from each:
 *
 *                  - A FIGURE environment (tikzcd, tikzpicture) is not drawn.
 *                    render-tikz.ts replaces a paragraph that IS the figure,
 *                    and a folded one never is. Nothing downstream says so
 *                    either: Pandoc exports the figure regardless, so an
 *                    export cannot reveal what the editor did not draw. That
 *                    is an error with a fix.
 *                  - Every OTHER environment still renders — math environments
 *                    became display math in both Pandoc and this editor. It is
 *                    merely part of a paragraph instead of standing alone,
 *                    which is a warning about the document's shape.
 *
 *                  Whether a figure renders is asked of render-tikz.ts's own
 *                  set, so the marker and the figure cannot disagree.
 *
 * END HEADER
 */

import { type Diagnostic } from '@codemirror/lint'
import { linter } from '@codemirror/lint'
import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { FIGURE_ENVIRONMENTS } from '../renderers/render-tikz'
import { wholeEnvironment } from '@common/util/math-delimiters'

/** An environment opening a line. Anchored per line, so prose that merely
 *  names one mid-sentence is not an environment. */
const OPEN_LINE_RE = /^\\begin\{([A-Za-z]+\*?)\}/gm

export function latexEnvironmentLintSource (view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const state = view.state

  syntaxTree(state).iterate({
    enter (node) {
      if (node.type.name !== 'Paragraph') {
        return
      }
      const text = state.sliceDoc(node.from, node.to)
      if (wholeEnvironment(text) !== null) {
        return // Already its own block.
      }
      for (const match of text.matchAll(OPEN_LINE_RE)) {
        const environment = match[1]
        const line = state.doc.lineAt(node.from + match.index)
        const drawsAFigure = FIGURE_ENVIRONMENTS.has(environment)
        diagnostics.push({
          from: line.from,
          to: line.to,
          severity: drawsAFigure ? 'error' : 'warning',
          message: drawsAFigure
            ? `This \\begin{${environment}} is part of the paragraph around it, so the figure will not be drawn. ` +
              'Markdown reads a line written directly under prose as a continuation of it. ' +
              'Put a blank line above the block and below its \\end, and it renders. ' +
              'Pandoc exports the figure either way, so an export will not show this.'
            : `This \\begin{${environment}} is part of the paragraph around it rather than a block of its own. ` +
              'It still renders. Markdown reads a line written directly under prose as a continuation of it, ' +
              'so the environment belongs to that paragraph; a blank line above and below makes it stand alone.',
          source: 'latex-environment-lint'
        })
      }
    }
  })

  return diagnostics
}

export const latexEnvironmentLint = linter(latexEnvironmentLintSource)

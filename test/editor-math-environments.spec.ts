/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc Markdown LaTeX-environment classification
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Pandoc's Markdown reader does NOT promote bare LaTeX
 *                  environments such as \begin{align} to Markdown Math nodes.
 *                  With raw_tex enabled, LaTeX-reader inline environments are
 *                  RawInline(tex); other environments may be RawBlock(tex).
 *                  Only Pandoc's explicit Markdown math delimiters ($, $$,
 *                  \( \), \[ \]) produce Math nodes. The editor may still
 *                  visualize Pandoc RawInline(tex) math environments without
 *                  changing that syntax classification.
 *
 *                  The executable Pandoc JSON reader is the oracle. Source:
 *                  Pandoc 3.10.2 commit
 *                  f2ee5dfee866aab007a33552acc6bc01810c6918,
 *                  Markdown.hs `math` / `rawLaTeXInline'` and LaTeX.hs
 *                  `rawLaTeXInline` / `rawLaTeXBlock`.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'
import { md2html } from 'source/common/modules/markdown-utils/markdown-to-html'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { stripMathDelimiters } from 'source/common/util/math-delimiters'
import { execPandocReference } from './pandoc-reference'

const RENDER_OPTS = { onCitation: () => undefined, zknLinkFormat: 'link|title' as const }
const PANDOC_READER = 'markdown+raw_tex+tex_math_dollars+tex_math_single_backslash'

function pandocTreatsEnvironmentAsMath (environment: string): boolean {
  const source = `\\begin{${environment}}\nx = y\n\\end{${environment}}`
  const raw = execPandocReference([ '-f', PANDOC_READER, '-t', 'json' ], { input: source })
  const document = JSON.parse(raw) as { blocks: Array<{ t: string, c?: unknown }> }
  const first = document.blocks[0]
  if (first?.t !== 'Para' || !Array.isArray(first.c)) {
    return false
  }
  return first.c.some((inline) => {
    return typeof inline === 'object' && inline !== null &&
      (inline as { t?: string }).t === 'Math'
  })
}

async function rendersAsDisplayMath (markdown: string): Promise<boolean> {
  const html = await md2html(markdown, RENDER_OPTS)
  return /<mjx-container[^>]*display="true"/.test(html)
}

/**
 * What the EDITOR would hand MathJax for the first math node it finds, or null
 * when it produces no math node at all. This is the path the preview widget
 * takes (render-math.ts slices the node and strips its delimiters), so it
 * answers the question the author actually asks: does the editor draw this?
 */
function editorMath (doc: string): { display: boolean, equation: string } | null {
  const state = EditorState.create({ doc, extensions: [markdownParser()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  assert.ok(tree !== null, 'the document must parse fully before asserting')
  let found: { display: boolean, equation: string } | null = null
  tree.iterate({
    enter (node) {
      // The node types render-math.ts itself accepts.
      if (found !== null || ![ 'InlineCode', 'FencedCode' ].includes(node.type.name)) {
        return
      }
      const firstChild = node.node.firstChild
      if (firstChild === null || firstChild.type.name !== 'CodeMark') {
        return
      }
      found = stripMathDelimiters(state.sliceDoc(node.from, node.to))
    }
  })
  return found
}

const ALIGN = '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}'

describe('Pandoc Markdown LaTeX-environment classification', function () {
  before(async function () {
    this.timeout(60000)
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  describe('the HTML conversion', function () {
    it('matches Pandoc for standalone LaTeX environment classification', async function () {
      for (const env of [
        'equation', 'gather', 'multline', 'align', 'align*', 'flalign',
        'dmath', 'subequations',
        // Ordinary TeX math environments that Pandoc keeps as raw TeX when
        // they stand alone in Markdown.
        'cases', 'matrix', 'aligned', 'center'
      ]) {
        const expected = pandocTreatsEnvironmentAsMath(env)
        assert.equal(
          await rendersAsDisplayMath(`\\begin{${env}}\nx = y\n\\end{${env}}`),
          expected,
          `\\begin{${env}} must match Pandoc's block classification`
        )
      }
    })

    it('leaves a non-math environment as ordinary text', async function () {
      const html = await md2html('\\begin{center}\nhello\n\\end{center}', RENDER_OPTS)
      assert.equal(/<mjx-container/.test(html), false)
      assert.equal(/<code/.test(html), false, 'it must not become a code span either')
    })
  })

  describe('the editor preview', function () {
    it('does not reclassify Pandoc raw-TeX environments as Markdown Math nodes', function () {
      assert.equal(editorMath(ALIGN), null)
      assert.equal(editorMath('\\begin{equation}\nx = y\n\\end{equation}'), null)
      assert.equal(editorMath('\\begin{center}\nhello\n\\end{center}'), null)
      assert.equal(editorMath('\\begin{cases}\nx = y\n\\end{cases}'), null)
    })

    it('leaves an unterminated environment alone rather than eating the document', function () {
      assert.equal(editorMath('\\begin{align}\na &= b\n\nA new paragraph.'), null)
    })

    it('still renders the dollar forms it always did', function () {
      assert.equal(editorMath('$$\n\\alpha\n$$')?.display, true)
      assert.equal(editorMath('$\\alpha$')?.display, false)
    })

    it('does not fire inside inline math that already delimits an environment', function () {
      // `$\begin{pmatrix}…\end{pmatrix}$` is one inline equation, not a display
      // block: the dollars own it, and the environment is its content.
      const math = editorMath('The matrix $\\begin{pmatrix}0&1\\\\1&0\\end{pmatrix}$ is hyperbolic.')
      assert.equal(math?.display, false, 'the dollar delimiters must still win')
      assert.equal(math?.equation, '\\begin{pmatrix}0&1\\\\1&0\\end{pmatrix}')
    })
  })
})

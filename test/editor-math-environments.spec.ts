/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LaTeX math environments
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Pandoc renders \begin{align} and its siblings as display
 *                  math, whether or not a blank line separates them from the
 *                  prose around them. The editor recognized four delimiters
 *                  ($, $$, \( \), \[ \]) and no environments at all, so an
 *                  author writing an aligned derivation saw the source text
 *                  and had no way to tell that the export would differ.
 *
 *                  The set of environments below is the one real Pandoc
 *                  treats as math; it was read off the binary rather than
 *                  recalled. `center` stands for everything outside that set,
 *                  which stays ordinary text here exactly as it does there.
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

const RENDER_OPTS = { onCitation: () => undefined, zknLinkFormat: 'link|title' as const }

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

describe('Editor renders LaTeX math environments', function () {
  before(async function () {
    this.timeout(60000)
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  describe('the HTML conversion', function () {
    it('renders an align environment standing alone as display math', async function () {
      assert.equal(await rendersAsDisplayMath(ALIGN), true)
    })

    it('renders it glued to the prose above, as Pandoc does', async function () {
      assert.equal(await rendersAsDisplayMath(`Consider the identity\n${ALIGN}\nwhich holds.`), true)
    })

    it('renders equation, gather, multline and cases', async function () {
      for (const env of [ 'equation', 'gather', 'multline', 'cases' ]) {
        assert.equal(
          await rendersAsDisplayMath(`\\begin{${env}}\nx = y\n\\end{${env}}`),
          true,
          `\\begin{${env}} must render as display math`
        )
      }
    })

    it('renders a starred environment', async function () {
      assert.equal(await rendersAsDisplayMath('\\begin{align*}\na &= b\n\\end{align*}'), true)
    })

    it('leaves a non-math environment as ordinary text', async function () {
      const html = await md2html('\\begin{center}\nhello\n\\end{center}', RENDER_OPTS)
      assert.equal(/<mjx-container/.test(html), false)
      assert.equal(/<code/.test(html), false, 'it must not become a code span either')
    })
  })

  describe('the editor preview', function () {
    it('hands MathJax the whole environment, which is what makes align align', function () {
      const math = editorMath(ALIGN)
      assert.notEqual(math, null, 'the editor must produce a math node for an environment')
      assert.equal(math?.display, true)
      assert.equal(
        math?.equation,
        ALIGN,
        'the \\begin and \\end must survive: MathJax needs them to set up the alignment'
      )
    })

    it('produces the same math node when the environment follows prose', function () {
      const math = editorMath(`Consider the identity\n${ALIGN}\nwhich holds.`)
      assert.equal(math?.equation, ALIGN)
      assert.equal(math?.display, true)
    })

    it('does not treat a non-math environment as math', function () {
      assert.equal(editorMath('\\begin{center}\nhello\n\\end{center}'), null)
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

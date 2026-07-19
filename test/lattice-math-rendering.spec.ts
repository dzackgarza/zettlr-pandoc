/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Lattice-theory display-math rendering probe
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * Description:     A TDD probe for how hard it is to render real research-grade
 *                  lattice/Coble-surface display math in the editor's MathJax
 *                  pipeline. It renders the author's actual expressions and
 *                  asserts every control sequence resolves.
 *
 *                  Key rendering fact this test encodes: MathJax does NOT emit an
 *                  <mjx-merror> for an UNDEFINED macro under this configuration.
 *                  It typesets the macro's literal name in RED
 *                  (<mjx-mtext style="color: red;" data-latex="\name">). So a
 *                  naive "no mjx-merror" check reports success while the output
 *                  is visibly broken. "Renders properly" therefore means: no
 *                  red literal-macro text.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { initializeMathJax, mathJaxToHTML } from 'source/common/util/mathtex-to-html'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'

// The author's real display math (terminal Coble surface of K3 type, n = 1).
const EXPRESSIONS: Array<{ label: string, tex: string }> = [
  {
    label: 'S_Co invariants',
    tex: 'S_{\\Co} \\da (11, 11, 1)_1 \\cong \\gens{-2} \\oplus E_{10}(2)'
  },
  {
    label: 'T_Co orthogonal complement',
    tex: 'T_{\\Co} \\da S_{\\Co}^{\\perp \\lkthree} = (11, 11, 1)_2 \\cong \\rm{I}_{2, 9}(2) \\cong \\gens{2} \\oplus E_{10}(2)'
  }
]

/**
 * Returns the distinct macro names MathJax rendered as red literals (i.e.
 * undefined control sequences). Empty means every macro resolved.
 */
function undefinedMacros (html: string): string[] {
  const names = new Set<string>()
  const re = /color:\s*red[^>]*data-latex="(\\[A-Za-z@]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    names.add(match[1])
  }
  return [ ...names ].sort()
}

describe('Lattice-theory display math renders every macro', function () {
  before(async function () {
    this.timeout(30000)
    // Shared fixture carries the corpus definitions of \Co, \da, \gens (and the
    // other specs' \RR etc.). initializeMathJax is a global one-shot, so every
    // math-rendering spec MUST initialize from the SAME fixture. \lkthree is
    // deliberately absent (mirroring the corpus), and \da expands to \coloneqq,
    // which base MathJax does not define -- so this test measures exactly which
    // control sequences remain unresolved in the editor pipeline.
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  for (const { label, tex } of EXPRESSIONS) {
    it(`${label}: typesets with no undefined macros`, function () {
      const html = mathJaxToHTML(tex, 'display')
      assert.match(html, /<mjx-container[^>]*display="true"/)
      const undefinedNames = undefinedMacros(html)
      assert.deepEqual(
        undefinedNames,
        [],
        `undefined macros rendered as red literals: ${undefinedNames.join(', ')}`
      )
    })
  }
})

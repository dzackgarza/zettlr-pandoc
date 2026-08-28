/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor LaTeX math-delimiter detection probe
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * Description:     The editor's math parser (markdown-editor/parser/math-parser)
 *                  recognizes ONLY `$` delimiters: `$...$` inline and a line that
 *                  is just `$$` opening/closing a display block. It has no rule
 *                  for LaTeX delimiters `\[ ... \]` (display) or `\( ... \)`
 *                  (inline), so math written that way is left as plain text in
 *                  the GUI even though Pandoc export handles it fine.
 *
 *                  This probes, through md2html (which uses the same math
 *                  parsers as the editor), whether each delimiter form is
 *                  detected as math. The `\[` / `\(` cases are the gap.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import { loadMathJaxMacros } from 'source/app/util/load-mathjax-macros'
import { md2html } from 'source/common/modules/markdown-utils/markdown-to-html'

const RENDER_OPTS = { onCitation: () => undefined, zknLinkFormat: 'link|title' as const }

async function rendersAsMath (markdown: string, kind: 'display' | 'inline'): Promise<boolean> {
  const html = await md2html(markdown, RENDER_OPTS)
  // Display math containers carry display="true"; inline math containers carry no
  // display attribute at all. So "inline math" = a container that is not display.
  const hasContainer = /<mjx-container/.test(html)
  const isDisplay = /<mjx-container[^>]*display="true"/.test(html)
  return kind === 'display' ? (hasContainer && isDisplay) : (hasContainer && !isDisplay)
}

describe('Editor detects LaTeX math delimiters', function () {
  before(async function () {
    this.timeout(30000)
    await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
  })

  // Baselines: the `$` forms the parser already supports.
  it('$$ … $$ block renders as display math', async function () {
    assert.equal(await rendersAsMath('$$\n\\RR\n$$', 'display'), true)
  })

  it('$ … $ renders as inline math', async function () {
    assert.equal(await rendersAsMath('$\\RR$', 'inline'), true)
  })

  // The gap: LaTeX delimiters the author actually writes.
  it('\\[ … \\] block renders as display math', async function () {
    assert.equal(await rendersAsMath('\\[\n\\RR\n\\]', 'display'), true)
  })

  it('\\( … \\) renders as inline math', async function () {
    assert.equal(await rendersAsMath('\\(\\RR\\)', 'inline'), true)
  })

  // Real-world shapes: display math written the way the author actually writes
  // it — the \[ block follows prose with no blank line (mid-paragraph), and the
  // closing \] may trail a sentence period on the same line ("…\n.\]").
  it('\\[ … \\] mid-paragraph (after prose, no blank line) renders as display', async function () {
    assert.equal(await rendersAsMath('with invariants\n\\[\n\\RR = \\RR\n\\]\nand complement', 'display'), true)
  })

  it('\\[ … .\\] with the closing delimiter after a trailing period renders as display', async function () {
    assert.equal(await rendersAsMath('with invariants\n\\[\n\\RR = \\RR\n.\\]\nand complement', 'display'), true)
  })
})

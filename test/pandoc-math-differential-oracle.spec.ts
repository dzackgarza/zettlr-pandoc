/** Differential oracle for Pandoc Markdown TeX-math delimiters. */

import { strict as assert } from 'node:assert'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { stripMathDelimiters } from 'source/common/util/math-delimiters'
import { execPandocReference } from './pandoc-reference'

const READER = 'markdown+tex_math_dollars+tex_math_single_backslash'

type MathKind = 'inline'|'display'

function pandocMathKinds (source: string): MathKind[] {
  const raw = execPandocReference(['-f', READER, '-t', 'json'], { input: source })
  const document = JSON.parse(raw) as unknown
  const kinds: MathKind[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (record.t === 'Math' && Array.isArray(record.c)) {
      const kind = record.c[0]
      if (typeof kind === 'object' && kind !== null) {
        kinds.push((kind as { t?: string }).t === 'DisplayMath' ? 'display' : 'inline')
      }
    }
    for (const child of Object.values(record)) visit(child)
  }
  visit(document)
  return kinds
}

function editorMathKinds (source: string): MathKind[] {
  const state = EditorState.create({ doc: source, extensions: [markdownParser()] })
  const tree = ensureSyntaxTree(state, source.length, 5000)
  assert.ok(tree !== null, 'editor document must parse fully')
  const kinds: MathKind[] = []
  tree.iterate({
    enter (node) {
      if (node.name !== 'InlineCode' && node.name !== 'FencedCode') return
      const parsed = stripMathDelimiters(state.sliceDoc(node.from, node.to))
      if (parsed !== null) kinds.push(parsed.display ? 'display' : 'inline')
    }
  })
  return kinds
}

const cases = [
  '$x$',
  '$$x$$',
  '\\(x\\)',
  '\\( x \\)',
  '\\( \\overline{{ \\mathcal{M}_{g, n} }} \\)',
  '\\[x\\]',
  'before $x$ after',
  'before $$x$$ after',
  '$ x$',
  '$x $',
  '$x$2',
  '$5',
  '$5 and $6',
  '$x\\text{ $ literal }y$',
  '$x\n y$',
  '$x\n\n y$',
  '\\(x\n y\\)',
  '\\( x\n y \\)',
  '\\[x\n y\\]',
  '\\[x\n\n y\\]',
  '$$\nx+y\n$$',
  '\\[\nx+y\n\\]'
] as const

const TRUNCATION_DIV = `::: {#def-good-truncation}
## Good truncation

For $n\\in\\mathbb Z$ let $\\tau_{\\ge n}C$ be the subcomplex of $C$ with
$$
(\\tau_{\\ge n}C)_i=
\\begin{cases}
0,& i<n,\\\\
Z_n(C),& i=n,\\\\
C_i,& i>n,
\\end{cases}
$$
and let $\\tau_{<n}C=C/\\tau_{\\ge n}C$.
Then $H_i(\\tau_{\\ge n}C)=H_i(C)$ for $i\\ge n$ and vanishes for $i<n$, while $H_i(\\tau_{<n}C)=H_i(C)$ for $i<n$ and vanishes for $i\\ge n$ [@Wei94, 1.2.7].
:::
`

describe('Pandoc math differential oracle', function () {
  this.timeout(60000)

  for (const source of cases) {
    it(`matches Pandoc for ${JSON.stringify(source)}`, function () {
      assert.deepEqual(editorMathKinds(source), pandocMathKinds(source))
    })
  }

  it('keeps raw-looking TeX inside a cross-line display expression owned by Pandoc math', function () {
    assert.deepEqual(editorMathKinds(TRUNCATION_DIV), pandocMathKinds(TRUNCATION_DIV))

    const state = EditorState.create({ doc: TRUNCATION_DIV, extensions: [markdownParser()] })
    const tree = ensureSyntaxTree(state, TRUNCATION_DIV.length, 5000)
    assert.ok(tree !== null)
    const names: string[] = []
    let divMarks = 0
    tree.iterate({
      enter (node) {
        names.push(node.name)
        if (node.name === 'PandocDivMark') divMarks++
      }
    })
    assert.equal(divMarks, 2, 'the closing fenced-div marker must survive the display-math parse')
    assert.ok(names.includes('Citation'), 'content after the display expression must remain in the syntax tree')
    assert.ok(!names.includes('RawBlock'), 'the cases environment belongs to the surrounding display math')
  })

  it('does not consume later blocks when a standalone display opener has no close', function () {
    const source = '$$\nunclosed\n\n## Still here\n'
    assert.deepEqual(editorMathKinds(source), pandocMathKinds(source))
    const state = EditorState.create({ doc: source, extensions: [markdownParser()] })
    const tree = ensureSyntaxTree(state, source.length, 5000)
    assert.ok(tree !== null)
    assert.match(tree.toString(), /ATXHeading/u)
  })
})

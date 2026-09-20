/** Differential oracle for Pandoc Markdown TeX-math delimiters. */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { stripMathDelimiters } from 'source/common/util/math-delimiters'

const READER = 'markdown+tex_math_dollars+tex_math_single_backslash'

type MathKind = 'inline'|'display'

function pandocMathKinds (source: string): MathKind[] {
  const raw = execFileSync('pandoc', ['-f', READER, '-t', 'json'], {
    input: source,
    encoding: 'utf8'
  })
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
  '\\[x\n y\\]',
  '\\[x\n\n y\\]',
  '$$\nx+y\n$$',
  '\\[\nx+y\n\\]'
] as const

describe('Pandoc math differential oracle', function () {
  this.timeout(60000)

  for (const source of cases) {
    it(`matches Pandoc for ${JSON.stringify(source)}`, function () {
      assert.deepEqual(editorMathKinds(source), pandocMathKinds(source))
    })
  }
})

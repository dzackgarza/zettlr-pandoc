import { strict as assert } from 'node:assert'
import type { TikzLivePreviewTarget } from 'source/common/modules/markdown-editor/tikz-live-preview'
import {
  TIKZ_PREVIEW_MODES,
  defaultTikzPreviewMode,
  resolvedTikzPreviewMode
} from 'source/common/modules/markdown-editor/tikz-preview-modes'

function target (source: string, language: 'tikz'|'tikzcd'): TikzLivePreviewTarget {
  return {
    from: 0,
    to: source.length,
    sourceFrom: 0,
    sourceTo: source.length,
    source,
    kind: 'raw',
    language,
    docPath: '/notes/diagram.md'
  }
}

describe('TikZ preview mode capabilities', function () {
  const visual = TIKZ_PREVIEW_MODES.find(mode => mode.id === 'visual')
  const quiver = TIKZ_PREVIEW_MODES.find(mode => mode.id === 'quiver')

  it('defaults tikzcd to Quiver and ordinary TikZ to the compiler', function () {
    assert.strictEqual(defaultTikzPreviewMode(target('A \\arrow[r] & B', 'tikzcd')), 'quiver')
    assert.strictEqual(defaultTikzPreviewMode(target('\\begin{tikzpicture}\n\\end{tikzpicture}', 'tikz')), 'tikz')
  })

  it('offers the visual mode only for an authored tikzpicture environment', function () {
    assert.ok(visual !== undefined)
    assert.strictEqual(
      visual.supports(target('\\begin{tikzpicture}\n\\node (a) at (0,0) {A};\n\\end{tikzpicture}', 'tikz')),
      true
    )
    assert.strictEqual(visual.supports(target('\\draw (0,0) -- (1,1);', 'tikz')), false)
    assert.strictEqual(visual.supports(target('\\input{figures/a.tikz}', 'tikz')), false)
    assert.strictEqual(visual.supports(target('\\begin{tikzcd}\nA & B\n\\end{tikzcd}', 'tikzcd')), false)
  })

  it('keeps Quiver exclusive to tikzcd', function () {
    assert.ok(quiver !== undefined)
    assert.strictEqual(quiver.supports(target('\\begin{tikzcd}\nA & B\n\\end{tikzcd}', 'tikzcd')), true)
    assert.strictEqual(quiver.supports(target('\\begin{tikzpicture}\n\\end{tikzpicture}', 'tikz')), false)
  })

  it('falls back to the target default if a requested provider is unsupported', function () {
    assert.strictEqual(
      resolvedTikzPreviewMode('visual', target('\\begin{tikzcd}\nA & B\n\\end{tikzcd}', 'tikzcd')),
      'quiver'
    )
    assert.strictEqual(
      resolvedTikzPreviewMode('quiver', target('\\begin{tikzpicture}\n\\end{tikzpicture}', 'tikz')),
      'tikz'
    )
  })
})


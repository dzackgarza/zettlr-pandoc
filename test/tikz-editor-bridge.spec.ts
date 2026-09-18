import { strict as assert } from 'node:assert'
import {
  tikzEditorReplacement,
  tikzEditorSessionForBlock
} from 'source/common/modules/markdown-editor/tikz-editor-bridge'
import type { TikzLivePreviewTarget } from 'source/common/modules/markdown-editor/tikz-live-preview'

describe('tikz-editor source bridge', function () {
  const source = String.raw`\begin{tikzpicture}
\begin{scope}[shift={(2,1)}, rotate=30]
  \node (A) at (0,0) {A};
\end{scope}
\foreach \i in {1,...,3} { \draw (\i,0) circle (2pt); }
\draw (0,0) .. controls (1,2) and (2,2) .. (3,0);
\end{tikzpicture}`

  function target (text = source): TikzLivePreviewTarget {
    return {
      from: 40,
      to: 40 + text.length,
      sourceFrom: 40,
      sourceTo: 40 + text.length,
      source: text,
      kind: 'raw',
      language: 'tikz',
      docPath: '/notes/diagram.md'
    }
  }

  it('hands arbitrary authored TikZ to the embedded editor byte-for-byte', function () {
    assert.strictEqual(tikzEditorSessionForBlock(target()).source, source)
  })

  it('accepts complete edited source without interpreting unsupported constructs', function () {
    const session = tikzEditorSessionForBlock(target())
    const edited = source.replace('{A};', '{B};') + '\n% arbitrary hand-authored tail'
    const replacement = tikzEditorReplacement(session, edited)

    assert.strictEqual(replacement.from, 40)
    assert.strictEqual(replacement.to, 40 + source.length)
    assert.strictEqual(replacement.insert, edited)
    assert.strictEqual(replacement.next.source, edited)
    assert.strictEqual(replacement.next.sourceTo, 40 + edited.length)
    assert.ok(replacement.insert.includes('\\foreach'))
    assert.ok(replacement.insert.includes('.. controls'))
  })

  it('rejects tikzcd at the bridge boundary', function () {
    const block = target(String.raw`\begin{tikzcd}A & B\end{tikzcd}`)
    block.language = 'tikzcd'
    assert.throws(() => tikzEditorSessionForBlock(block), /ordinary TikZ/u)
  })
})

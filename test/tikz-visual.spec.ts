import { strict as assert } from 'node:assert'
import {
  addTikzVisualArrow,
  addTikzVisualNode,
  deleteTikzVisualArrow,
  editTikzVisualNodeLabel,
  moveTikzVisualNode,
  nextTikzVisualNodeName,
  parseTikzVisualScene,
  replaceVisualSessionSource,
  visualSessionForBlock
} from 'source/common/modules/markdown-editor/tikz-visual'
import type { TikzLivePreviewTarget } from 'source/common/modules/markdown-editor/tikz-live-preview'

const SOURCE = String.raw`\begin{tikzpicture}[
    square/.style={rectangle, draw, minimum width=3cm, minimum height=0.8cm},
    circ/.style={circle, draw, minimum size=0.8cm}
]

% Define nodes
\node[circ] (eta) at (0,0) {$\eta$};
\node[square] (A1) at (4,3) {$A_1 \oplus E_8^{\oplus 2}$};
\node[square] (E7) at (4,1) {$E_7 \oplus D_{10}$};
\node[square] (D16) at (4,-1) {$A_1 \oplus D_{16}$};
\node[square] (A17) at (4,-3) {$A_{17}$};

% Draw arrows
\draw[->] (eta.east) -- (A1.west);
\draw[->] (eta.east) -- (E7.west);
\draw[->] (eta.east) -- (D16.west);
\draw[->] (eta.east) -- (A17.west);

\end{tikzpicture}`

describe('TikZ visual source model', function () {
  it('projects the motivating tikzpicture through the Lezer grammar', function () {
    const scene = parseTikzVisualScene(SOURCE)
    assert.strictEqual(scene.nodes.length, 5)
    assert.strictEqual(scene.arrows.length, 4)
    assert.strictEqual(scene.warnings.length, 0)

    const eta = scene.nodes.find(node => node.name === 'eta')
    const a1 = scene.nodes.find(node => node.name === 'A1')
    assert.ok(eta !== undefined && a1 !== undefined)
    assert.deepStrictEqual({ x: eta.x, y: eta.y, shape: eta.shape }, { x: 0, y: 0, shape: 'circle' })
    assert.deepStrictEqual(
      { x: a1.x, y: a1.y, shape: a1.shape, width: a1.widthCm, height: a1.heightCm },
      { x: 4, y: 3, shape: 'rectangle', width: 3, height: 0.8 }
    )
    assert.strictEqual(scene.styles.find(style => style.name === 'circ')?.minimumSizeCm, 0.8)
    assert.deepStrictEqual(
      scene.arrows[0] === undefined
        ? null
        : {
            from: scene.arrows[0].from,
            to: scene.arrows[0].to,
            forward: scene.arrows[0].forwardArrow
          },
      {
        from: { node: 'eta', anchor: 'east', span: scene.arrows[0].from.span },
        to: { node: 'A1', anchor: 'west', span: scene.arrows[0].to.span },
        forward: true
      }
    )
  })

  it('moves one literal coordinate without regenerating surrounding source', function () {
    const scene = parseTikzVisualScene(SOURCE)
    const a1 = scene.nodes.find(node => node.name === 'A1')
    assert.ok(a1 !== undefined)
    const updated = moveTikzVisualNode(scene, a1.id, 5.5, -2)
    assert.strictEqual(updated, SOURCE.replace('(A1) at (4,3)', '(A1) at (5.5,-2)'))
  })

  it('edits only the node text group payload', function () {
    const scene = parseTikzVisualScene(SOURCE)
    const eta = scene.nodes.find(node => node.name === 'eta')
    assert.ok(eta !== undefined)
    const updated = editTikzVisualNodeLabel(scene, eta.id, String.raw`$\theta$`)
    assert.strictEqual(updated, SOURCE.replace(String.raw`{$\eta$}`, String.raw`{$\theta$}`))
  })

  it('adds nodes using matching named styles when available', function () {
    const scene = parseTikzVisualScene(SOURCE)
    const updated = addTikzVisualNode(scene, {
      shape: 'circle',
      name: 'xi',
      label: String.raw`$\xi$`,
      x: -2,
      y: 1.5
    })
    assert.match(updated, /\\node\[circ\] \(xi\) at \(-2,1\.5\) \{\$\\xi\$\};\n\\end\{tikzpicture\}/u)
    assert.strictEqual(nextTikzVisualNodeName(parseTikzVisualScene(updated)), 'node1')
  })

  it('adds a directed named-node edge with geometric anchors', function () {
    const scene = parseTikzVisualScene(SOURCE)
    const eta = scene.nodes.find(node => node.name === 'eta')
    const a1 = scene.nodes.find(node => node.name === 'A1')
    assert.ok(eta !== undefined && a1 !== undefined)
    const updated = addTikzVisualArrow(scene, eta.id, a1.id)
    assert.match(updated, /\\draw\[->\] \(eta\.east\) -- \(A1\.west\);\n\\end\{tikzpicture\}/u)
  })

  it('deletes a visual arrow without leaving an empty indentation line', function () {
    const indented = SOURCE.replace(
      '\\draw[->] (eta.east) -- (A1.west);',
      '    \\draw[->] (eta.east) -- (A1.west);'
    )
    const scene = parseTikzVisualScene(indented)
    const arrow = scene.arrows.find(candidate => candidate.to.node === 'A1')
    assert.ok(arrow !== undefined)
    const updated = deleteTikzVisualArrow(scene, arrow.id)
    assert.ok(!updated.includes('\\draw[->] (eta.east) -- (A1.west);'))
    assert.ok(!updated.includes('\n    \n'))
    assert.ok(updated.includes('\\draw[->] (eta.east) -- (E7.west);'))
  })

  it('leaves unsupported paths in source while reporting them as source-only', function () {
    const source = SOURCE.replace(
      String.raw`\draw[->] (eta.east) -- (A1.west);`,
      String.raw`\draw[very thick] (0,0) .. controls (1,2) and (2,2) .. (3,0);`
    )
    const scene = parseTikzVisualScene(source)
    assert.strictEqual(scene.arrows.length, 3)
    assert.ok(scene.warnings.some(warning => warning.includes('draw path')))
    const moved = moveTikzVisualNode(scene, scene.nodes[0].id, 1, 1)
    assert.ok(moved.includes(String.raw`\draw[very thick] (0,0) .. controls (1,2) and (2,2) .. (3,0);`))
  })

  it('tracks CodeMirror source-range growth after an interactive replacement', function () {
    const target: TikzLivePreviewTarget = {
      from: 100,
      to: 100 + SOURCE.length,
      sourceFrom: 100,
      sourceTo: 100 + SOURCE.length,
      source: SOURCE,
      kind: 'raw',
      language: 'tikz',
      docPath: '/notes/diagram.md'
    }
    const session = visualSessionForBlock(target)
    const nextSource = SOURCE.replace('(4,3)', '(40,30)')
    const replacement = replaceVisualSessionSource(session, nextSource)
    assert.deepStrictEqual(
      { from: replacement.from, to: replacement.to, sourceTo: replacement.next.sourceTo },
      { from: 100, to: 100 + SOURCE.length, sourceTo: 100 + nextSource.length }
    )
  })
})

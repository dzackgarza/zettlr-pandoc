/**
 * Rich TikZ syntax highlighting: upstream Lezer TikZ grammar plus the local
 * tikzcd matrix/arrow language, embedded in both fences and raw environments.
 */

import { strict as assert } from 'node:assert'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree } from '@codemirror/language'
import { toggleComment } from '@codemirror/commands'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { markdownSyntaxHighlighter } from 'source/common/modules/markdown-editor/theme/syntax'

function polyfillCodeMirror (): void {
  const w = globalThis as any
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    w.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (typeof w.window === 'object') w.window.ResizeObserver = w.ResizeObserver
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({})
    })
  }
}

function innerNodeName (state: EditorState, source: string, token: string): string {
  const pos = source.indexOf(token)
  assert.ok(pos >= 0, `fixture must contain ${token}`)
  return syntaxTree(state).resolveInner(pos + 1, 1).name
}

function stateFor (doc: string): EditorState {
  return EditorState.create({ doc, extensions: [ markdownParser() ] })
}

describe('TikZ grammar integration', function () {
  before(polyfillCodeMirror)

  it('uses the upstream Lezer TikZ grammar in fenced tikz blocks', function () {
    const doc = '```tikz\n\\draw[thick, blue] (0,0) -- (2,1) node[midway, above] {$f$};\n```'
    const state = stateFor(doc)
    assert.strictEqual(innerNodeName(state, doc, '\\draw'), 'DrawCmd')
    assert.strictEqual(innerNodeName(state, doc, 'thick'), 'Identifier')
    assert.strictEqual(innerNodeName(state, doc, '--'), 'PathOperator')
    assert.strictEqual(innerNodeName(state, doc, 'midway'), 'Identifier')
  })

  it('embeds the same upstream grammar into raw tikzpicture paragraphs', function () {
    const doc = '\\begin{tikzpicture}\n\\draw[fill=blue] (0,0) circle (1);\n\\end{tikzpicture}'
    const state = stateFor(doc)
    assert.strictEqual(innerNodeName(state, doc, '\\begin{tikzpicture}'), 'BeginTikz')
    assert.strictEqual(innerNodeName(state, doc, '\\draw'), 'DrawCmd')
    assert.strictEqual(innerNodeName(state, doc, 'circle'), 'CircleKw')
  })

  it('gives tikzcd its own matrix/arrow syntax in both raw and fenced forms', function () {
    const body = 'A \\arrow[r, "f", bend left] & B \\\\\nC & D'
    for (const doc of [
      `\\begin{tikzcd}\n${body}\n\\end{tikzcd}`,
      `\`\`\`tikzcd\n${body}\n\`\`\``
    ]) {
      const state = stateFor(doc)
      assert.strictEqual(innerNodeName(state, doc, '\\arrow'), 'keyword')
      assert.strictEqual(innerNodeName(state, doc, 'bend left'), 'propertyName')
      assert.strictEqual(innerNodeName(state, doc, '"f"'), 'string')
    }
  })

  it('exposes TeX line comments to the standard Mod-/ command in raw and fenced tikzcd', function () {
    const fixtures = [
      {
        name: 'raw',
        doc: '\\begin{tikzcd}\nA \\arrow[r] & B \\\\\nC \\arrow[r] & D\n\\end{tikzcd}',
      },
      {
        name: 'fenced',
        doc: '```tikzcd\nA \\arrow[r] & B \\\\\nC \\arrow[r] & D\n```',
      },
    ]

    for (const fixture of fixtures) {
      const bodyFrom = fixture.doc.indexOf('A \\arrow')
      const bodyTo = fixture.doc.indexOf('D') + 1
      const view = new EditorView({
        state: EditorState.create({
          doc: fixture.doc,
          selection: { anchor: bodyFrom, head: bodyTo },
          extensions: [ markdownParser() ]
        }),
        parent: document.body
      })
      try {
        assert.ok(forceParsing(view, fixture.doc.length, 5000), `${fixture.name}: syntax parsing must finish`)
        assert.deepStrictEqual(
          view.state.languageDataAt<{ line: string }>('commentTokens', bodyFrom)[0],
          { line: '%' },
          `${fixture.name}: the nested tikzcd language owns TeX line comments`
        )

        assert.strictEqual(toggleComment(view), true, `${fixture.name}: the standard comment command handles the selection`)
        const commented = view.state.doc.toString()
        const selectedLines = commented.slice(commented.indexOf('A') - 2, commented.indexOf('D') + 1)
        assert.match(selectedLines, /%\s*A \\arrow\[r\] & B/, `${fixture.name}: first selected line is commented`)
        assert.match(selectedLines, /%\s*C \\arrow\[r\] & D/, `${fixture.name}: second selected line is commented`)

        assert.strictEqual(toggleComment(view), true, `${fixture.name}: Mod-/ toggles the comments back off`)
        assert.strictEqual(view.state.doc.toString(), fixture.doc, `${fixture.name}: uncomment restores source byte-for-byte`)

        const singleLineAt = view.state.doc.toString().indexOf('A \\arrow') + 2
        view.dispatch({ selection: { anchor: singleLineAt } })
        assert.strictEqual(toggleComment(view), true, `${fixture.name}: a cursor-only Mod-/ comments one line`)
        const singleCommented = view.state.doc.toString()
        assert.match(singleCommented, /%\s*A \\arrow\[r\] & B/, `${fixture.name}: cursor line is commented`)
        assert.doesNotMatch(singleCommented, /%\s*C \\arrow\[r\] & D/, `${fixture.name}: neighboring line stays untouched`)
        assert.strictEqual(toggleComment(view), true, `${fixture.name}: cursor-only Mod-/ toggles back off`)
        assert.strictEqual(view.state.doc.toString(), fixture.doc, `${fixture.name}: single-line uncomment restores source byte-for-byte`)
      } finally {
        view.destroy()
        document.body.replaceChildren()
      }
    }
  })

  it('does not misclassify raw TikZ as Markdown inline code', function () {
    const doc = '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}'
    const state = stateFor(doc)
    const tree = syntaxTree(state).toString()
    assert.match(tree, /TikzRaw\(TikzFile\(TikzEnvironment/)
    assert.doesNotMatch(tree, /InlineCode\(TikzFile/)
  })

  it('projects grammar tags through Zettlr\'s existing syntax-theme CSS classes', function () {
    const doc = [
      '```tikz',
      '\\draw[thick, blue] (0,0) -- (2,1);',
      '```',
      '',
      '```tikzcd',
      'A \\arrow[r, "f", bend left] & B',
      '```'
    ].join('\n')
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [ markdownParser(), markdownSyntaxHighlighter() ]
      }),
      parent: document.body
    })
    try {
      assert.ok(forceParsing(view, doc.length, 5000), 'syntax parsing must finish')
      view.requestMeasure()
      const keywords = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-keyword')).map(node => node.textContent)
      assert.ok(keywords.some(text => text?.includes('\\draw') === true), 'ordinary TikZ command is visibly keyword-highlighted')
      assert.ok(keywords.some(text => text?.includes('\\arrow') === true), 'tikzcd arrow is visibly keyword-highlighted')
      assert.ok(
        Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-property-name')).some(node => node.textContent?.includes('bend left') === true),
        'tikzcd arrow option is visibly property-highlighted'
      )
      assert.ok(
        Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-string')).some(node => node.textContent?.includes('"f"') === true),
        'tikzcd arrow label is visibly string-highlighted'
      )
    } finally {
      view.destroy()
      document.body.replaceChildren()
    }
  })
})

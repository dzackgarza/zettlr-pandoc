import { strict as assert } from 'assert'
import './provision-renderer-window-seams'
import {
  CompletionContext,
  clearSnippet,
  currentCompletions,
  nextSnippetField,
  prevSnippetField,
  startCompletion,
  type Completion,
} from '@codemirror/autocomplete'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView as CodeMirrorView, type EditorView } from '@codemirror/view'
import { indentUnit } from '@codemirror/language'
import markdownParser from '../source/common/modules/markdown-editor/parser/markdown-parser'
import {
  codeMirrorTemplateForSnippet,
  snippetPresentationFor,
  snippetScopesAt,
  snippets,
  snippetsUpdate,
  snippetsUpdateField,
} from '../source/common/modules/markdown-editor/autocomplete/snippets'
import {
  autocomplete,
  autocompleteSourceFor,
  bufferWordSource,
} from '../source/common/modules/markdown-editor/autocomplete'
import { mainEditorKeybindings } from '../source/common/modules/markdown-editor/keymaps/default'
import {
  EMPTY_QUICKTEX,
  expandQuickTexOnSpace,
  quickTexField,
} from '../source/common/modules/markdown-editor/quicktex'
import {
  getDefaultConfig,
  configField,
} from '../source/common/modules/markdown-editor/util/configuration'
import {
  isSnippetFileName,
  parseVSCodeSnippetFile,
} from '../source/common/modules/snippets/vscode-snippet-file'
import type { UserSnippet } from '../source/types/common/snippets'
import type { QuickTexCatalogue } from '../source/types/common/quicktex'

function userSnippet (overrides: Partial<UserSnippet> = {}): UserSnippet {
  return {
    name: 'Theorem',
    prefixes: ['thm'],
    body: '::: {.theorem}\n${1:Statement}\n:::\n$0',
    scopes: ['markdown'],
    include: [],
    exclude: [],
    sourceFile: 'snippets.code-snippets',
    ...overrides,
  }
}

function editor (
  doc: string,
  userSnippets: UserSnippet[] = [],
  options: { path?: string, pos?: number, quickTex?: QuickTexCatalogue } = {}
): EditorView {
  const config = getDefaultConfig()
  config.metadata.path = options.path ?? '/tmp/note.md'
  const pos = options.pos ?? doc.length
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      configField.init(() => config),
      indentUnit.of(' '.repeat(config.indentUnit)),
      snippetsUpdateField.init(() => userSnippets),
      quickTexField.init(() => options.quickTex ?? EMPTY_QUICKTEX),
      markdownParser(),
    ]
  })
  let currentState = state
  return {
    get state () { return currentState },
    dispatch (transaction: Transaction|TransactionSpec) {
      currentState = transaction instanceof Transaction
        ? transaction.state
        : currentState.update(transaction).state
    }
  } as unknown as EditorView
}

describe('portable VS Code snippet files', function () {
  it('parses JSONC, arrays, scopes and file-pattern fields', function () {
    const parsed = parseVSCodeSnippetFile('research.code-snippets', `{
      // This is valid in VS Code snippet files.
      "Theorem": {
        "scope": "markdown, latex",
        "prefix": ["thm", "theorem"],
        "body": ["::: {.theorem}", "\${1:Statement}", ":::", "$0"],
        "description": "Pandoc theorem",
        "include": "*.md",
        "exclude": ["draft-*.md"],
      },
    }`)

    assert.deepEqual(parsed.diagnostics, [])
    assert.deepEqual(parsed.snippets, [{
      name: 'Theorem',
      prefixes: ['thm', 'theorem'],
      body: '::: {.theorem}\n${1:Statement}\n:::\n$0',
      description: 'Pandoc theorem',
      scopes: ['markdown', 'latex'],
      include: ['*.md'],
      exclude: ['draft-*.md'],
      sourceFile: 'research.code-snippets',
    }])
  })

  it('accepts only the standard .code-snippets storage surface', function () {
    assert.equal(isSnippetFileName('research.code-snippets'), true)
    assert.equal(isSnippetFileName('legacy.tpl.md'), false)
    assert.equal(isSnippetFileName('quicktex.vim'), false)
  })
})

describe('CodeMirror-native snippet host', function () {
  it('uses CodeMirror native snippet navigation in the editor keymap', function () {
    const bindings = mainEditorKeybindings([], getDefaultConfig())
    const tabs = bindings.filter(binding => binding.key === 'Tab')
    const shiftTabs = bindings.filter(binding => binding.key === 'Shift-Tab')
    const escapes = bindings.filter(binding => binding.key === 'Escape')

    assert.equal(tabs[1].run, nextSnippetField)
    assert.equal(shiftTabs[0].run, prevSnippetField)
    assert.equal(escapes[1].run, clearSnippet)
  })

  it('adapts VS Code numbered fields to CodeMirror and lets CodeMirror own field state', function () {
    const view = editor('pair')
    const template = codeMirrorTemplateForSnippet(view.state, '${1:left} + ${2:right}$0')
    const apply = (awaitImportSnippet())(template)
    apply(view, null, 0, 4)
    assert.equal(view.state.doc.toString(), 'left + right')
    assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'left')
    assert.equal(nextSnippetField(view), true)
    assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'right')
    assert.equal(prevSnippetField(view), true)
  })

  it('keeps repeated fields mirrored through CodeMirror multiple selections', function () {
    const view = editor('env')
    const template = codeMirrorTemplateForSnippet(view.state, '\\begin{${1:align}}\n$0\n\\end{$1}')
    const apply = (awaitImportSnippet())(template)
    apply(view, null, 0, 3)
    assert.equal(view.state.selection.ranges.length, 2)
    const ranges = [...view.state.selection.ranges]
    view.dispatch({ changes: ranges.map(range => ({ from: range.from, to: range.to, insert: 'gather' })) })
    assert.equal(view.state.doc.toString(), '\\begin{gather}\n\n\\end{gather}')
  })

  it('uses Microsoft parsers/resolvers for standard time variables before handing off to CodeMirror', function () {
    const view = editor('date')
    const template = codeMirrorTemplateForSnippet(view.state, '$CURRENT_YEAR$0')
    assert.match(template, /^\d{4}\$\{0\}$/)
  })

  it('refuses rich placeholder constructs CodeMirror cannot execute rather than reimplementing a second runtime', function () {
    const view = editor('choice')
    assert.throws(
      () => codeMirrorTemplateForSnippet(view.state, '${1|left,right|}$0'),
      Error
    )
  })
})

// Keep the native snippet import out of the module-under-test so this spec
// proves that its adapter targets the public CodeMirror API.
function awaitImportSnippet (): typeof import('@codemirror/autocomplete')['snippet'] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@codemirror/autocomplete').snippet
}

describe('always-on completion sources', function () {
  it('offers actual snippets during ordinary typing, not only explicit completion', function () {
    const view = editor('th', [userSnippet()])
    const ctx = new CompletionContext(view.state, 2, false)
    const result = autocompleteSourceFor(snippets, 25)(ctx)
    assert.ok(result !== null && !(result instanceof Promise))
    assert.ok(result.options.some(option => option.label === 'thm'))
    const thm = result.options.find(option => option.label === 'thm')!
    assert.strictEqual(thm.detail, 'Theorem · fenced div .theorem')
    assert.strictEqual((thm as Completion & { zettlrSource?: string }).zettlrSource, 'Pandoc')
    assert.equal(typeof thm.info, 'function')
    const info = (thm.info as (completion: Completion) => Node)(thm)
    assert.match(info.textContent ?? '', /Pandoc fenced div \.theorem/u)
    assert.match(info.textContent ?? '', /::: \{\.theorem\}/u)
  })

  it('labels snippet completions by the notation they insert, not merely by storage mechanism', function () {
    assert.deepEqual(snippetPresentationFor(userSnippet({
      name: 'Lemma',
      description: 'Lemma',
      prefixes: ['lem'],
      body: '::: {.lemma title="${1:?}"}\n${2}\n:::'
    })), {
      source: 'Pandoc',
      detail: 'Lemma · fenced div .lemma',
      notation: 'Pandoc fenced div .lemma'
    })

    assert.equal(snippetPresentationFor(userSnippet({
      name: 'Cases',
      description: 'Cases',
      body: '\\begin{cases}\n${1}\n\\end{cases}'
    })).source, 'LaTeX')

    assert.equal(snippetPresentationFor(userSnippet({
      name: 'Diagram',
      description: 'Diagram',
      body: '\\begin{tikzcd}\n${1}\n\\end{tikzcd}'
    })).source, 'tikzcd')
  })

  it('uses CodeMirror completeAnyWord as the buffer-word source', function () {
    const view = editor('algebra algebraic alg')
    const ctx = new CompletionContext(view.state, view.state.doc.length, false)
    const result = bufferWordSource(ctx)
    assert.ok(result !== null && !(result instanceof Promise))
    assert.ok(result.options.some(option => option.label === 'algebra'))
    assert.ok(result.options.some(option => option.label === 'algebraic'))
    assert.equal(
      (result.options.find(option => option.label === 'algebra') as (Completion & { zettlrSource?: string })|undefined)?.zettlrSource,
      'Buffer'
    )
  })

  it('merges and ranks snippet and buffer-word candidates in the real production completion session', async function () {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = globalThis.requestAnimationFrame
      window.cancelAnimationFrame = globalThis.cancelAnimationFrame
    }
    const rangePrototype = globalThis.Range.prototype
    if (typeof rangePrototype.getClientRects !== 'function') {
      Object.defineProperty(rangePrototype, 'getClientRects', {
        configurable: true,
        value: () => Object.assign([] as DOMRect[], { item: (_index: number) => null })
      })
      Object.defineProperty(rangePrototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
        bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
        toJSON: () => ({})
        } as DOMRect)
      })
    }
    if (typeof globalThis.ResizeObserver !== 'function') {
      globalThis.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} } as typeof ResizeObserver
    }

    const state = EditorState.create({
      doc: 'algebra algebraic al',
      selection: { anchor: 'algebra algebraic al'.length },
      extensions: [markdownParser(), configField, autocomplete]
    })
    const view = new CodeMirrorView({ state, parent: document.body })
    try {
      view.dispatch({ effects: snippetsUpdate.of([userSnippet({ prefixes: ['alg'], body: '${1:snippet}$0' })]) })
      view.focus()
      startCompletion(view)
      // Completion sources resolve asynchronously; a loaded CI runner needs
      // well over the few hundred milliseconds a workstation does.
      const deadline = Date.now() + 5000
      while (currentCompletions(view.state).length === 0 && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      const completions = currentCompletions(view.state)
      const labels = completions.map(option => option.label)
      assert.ok(labels.includes('alg'), `snippet missing from ${JSON.stringify(labels)}`)
      assert.ok(labels.includes('algebra'), `buffer word missing from ${JSON.stringify(labels)}`)
      assert.ok(labels.includes('algebraic'), `buffer word missing from ${JSON.stringify(labels)}`)
      assert.ok(labels.indexOf('alg') < labels.indexOf('algebra'), 'snippet boost should rank above buffer words for the same prefix')
    } finally {
      view.destroy()
      document.body.replaceChildren()
    }
  })

  it('exposes latex-scoped snippets inside Markdown math without changing their file format', function () {
    const view = editor('$ga$', [], { pos: 3 })
    assert.equal(snippetScopesAt(view.state, 3).has('latex'), true)
  })

  it('exposes latex and TikZ snippet scopes while editing TikZ/TikZCD source', function () {
    const tikz = editor('```tikz\n\\draw (0,0) -- (1,1);\n```', [], { pos: 15 })
    const tikzScopes = snippetScopesAt(tikz.state, 15)
    assert.equal(tikzScopes.has('latex'), true)
    assert.equal(tikzScopes.has('tex'), true)
    assert.equal(tikzScopes.has('tikz'), true)

    const tikzcdDoc = '\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}'
    const tikzcdPos = tikzcdDoc.indexOf('\\arrow') + 3
    const tikzcd = editor(tikzcdDoc, [], { pos: tikzcdPos })
    const tikzcdScopes = snippetScopesAt(tikzcd.state, tikzcdPos)
    assert.equal(tikzcdScopes.has('latex'), true)
    assert.equal(tikzcdScopes.has('tikz'), true)
    assert.equal(tikzcdScopes.has('tikzcd'), true)
  })
})

describe('QuickTeX is a separate aggressive Space mechanism', function () {
  const catalogue: QuickTexCatalogue = {
    sourceFile: '/tmp/quicktex.vim',
    diagnostics: [],
    excludeChars: ['{', '(', '['],
    prose: {
      cts: 'continuous<Space>',
      ab: 'abelian<Space>',
      m: '\\(<Space><lt>+++><Space>\\)<Space><lt>++>',
    },
    math: {
      ga: '\\alpha',
      frac: '\\frac{<lt>+++>}{<lt>++>}<Space><lt>++>',
      ' ': '<Esc>:call<Space>search(\'<lt>+.*+>\')<CR>"_c/+>/e<CR>',
    }
  }

  it('inserts the configured expansion including its trailing Space', function () {
    const view = editor('cts', [], { quickTex: catalogue })
    assert.equal(expandQuickTexOnSpace(view), true)
    assert.equal(view.state.doc.toString(), 'continuous ')
  })

  it('preserves another prose expansion trailing Space byte-for-byte', function () {
    const view = editor('ab', [], { quickTex: catalogue })
    assert.equal(expandQuickTexOnSpace(view), true)
    assert.equal(view.state.doc.toString(), 'abelian ')
  })

  it('uses only the math dictionary in Markdown math, never prose fallback', function () {
    const view = editor('\\( ga \\)', [], { pos: 5, quickTex: catalogue })
    assert.equal(expandQuickTexOnSpace(view), true)
    assert.equal(view.state.doc.toString(), '\\( \\alpha \\)')
  })

  it('returns false immediately on a miss so the ordinary Space binding runs', function () {
    const view = editor('ordinary', [], { quickTex: catalogue })
    assert.equal(expandQuickTexOnSpace(view), false)
    assert.equal(view.state.doc.toString(), 'ordinary')
  })

  it('preserves QuickTeX jump markers and places the cursor at <+++>', function () {
    const view = editor('\\( frac \\)', [], { pos: 7, quickTex: catalogue })
    assert.equal(expandQuickTexOnSpace(view), true)
    assert.equal(view.state.doc.toString(), '\\( \\frac{}{<++>} <++> \\)')
    assert.equal(view.state.selection.main.head, '\\( \\frac{'.length)
  })

  it('double-space consumes the previous space and jumps to the next QuickTeX marker', function () {
    const view = editor('$x <++>$', [], { pos: 3, quickTex: catalogue })
    assert.equal(expandQuickTexOnSpace(view), true)
    assert.equal(view.state.doc.toString(), '$x$')
    assert.equal(view.state.selection.main.head, 2)
  })

  it('is the first Space binding, ahead of autocorrect and literal insertion', function () {
    const bindings = mainEditorKeybindings([], getDefaultConfig())
    const spaces = bindings.filter(binding => binding.key === 'Space')
    assert.equal(spaces[0].run, expandQuickTexOnSpace)
  })
})

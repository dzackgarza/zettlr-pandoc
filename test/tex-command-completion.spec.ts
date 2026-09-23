import { strict as assert } from 'node:assert'
import {
  CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { EditorState, Text } from '@codemirror/state'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import {
  texCommandCompletionSource,
  texCommandDiagnostics,
  texDocumentKind,
  texMacroSourcesField
} from 'source/common/modules/markdown-editor/autocomplete/tex'
import {
  phraseCompletionSource,
  phraseCompletionsField
} from 'source/common/modules/markdown-editor/autocomplete/phrases'

const bs = String.fromCharCode(92)

function stateFor (
  doc: string,
  kind: 'markdown'|'latex'|'yaml' = 'markdown',
  macroSources: readonly { path: string, content: string }[] = []
): EditorState {
  const extensions = [
    texDocumentKind.of(kind),
    texMacroSourcesField.init(() => macroSources)
  ]
  if (kind === 'markdown') {
    extensions.push(markdownParser({ zknLinkParserConfig: { format: 'link|title' } }))
  }
  return EditorState.create({ doc, extensions })
}

async function completionFor (
  state: EditorState,
  pos = state.doc.length,
  explicit = true
): Promise<CompletionResult|null> {
  return await texCommandCompletionSource(new CompletionContext(state, pos, explicit))
}

function optionLabels (result: CompletionResult|null): string[] {
  return result?.options.map(option => option.label) ?? []
}

describe('package-aware TeX command completion', function () {
  it('activates mathtools and its amsmath/amsopn dependency closure in Markdown', async function () {
    const doc = [
      '---',
      'header-includes:',
      '  - ' + bs + 'usepackage{mathtools}',
      '---',
      '',
      '$' + bs + 'xma'
    ].join('\n')
    const state = stateFor(doc)
    const result = await completionFor(state)
    const labels = optionLabels(result)
    assert.ok(labels.includes(bs + 'xmapsto'))
    assert.ok(labels.includes(bs + 'operatorname'))
    assert.equal(result?.from, doc.lastIndexOf(bs))
  })

  it('classifies known inactive-package commands separately from unknown commands', function () {
    const doc = [
      '$' + bs + 'xmapsto$',
      '$' + bs + 'definitelyNotATeXCommand$'
    ].join('\n')
    const diagnostics = texCommandDiagnostics(stateFor(doc))
    const inactive = diagnostics.find(diagnostic => diagnostic.from === doc.indexOf(bs))
    const unknown = diagnostics.find(diagnostic => diagnostic.from === doc.lastIndexOf(bs))
    assert.equal(inactive?.data.kind, 'inactive-package')
    if (inactive?.data.kind === 'inactive-package') {
      assert.ok(inactive.data.providers.includes('mathtools'))
    }
    assert.deepEqual(unknown?.data, { kind: 'unknown' })
  })

  it('preserves diagnostic source ranges in CRLF documents', function () {
    const command = bs + 'definitelyNotATeXCommand'
    const doc = 'first line\r\n$' + command + '$'
    // MarkdownEditor loads authority content through Text.of(content.split('\n')),
    // which deliberately preserves CR bytes instead of CodeMirror's string
    // constructor normalizing CRLF to LF.
    const state = EditorState.create({
      doc: Text.of(doc.split('\n')),
      extensions: [
        texDocumentKind.of('markdown'),
        texMacroSourcesField,
        markdownParser({ zknLinkParserConfig: { format: 'link|title' } })
      ]
    })
    const diagnostics = texCommandDiagnostics(state)
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].from, doc.indexOf(command))
    assert.equal(diagnostics[0].to, doc.indexOf(command) + command.length)
  })

  it('offers commands in raw TeX but never in ordinary code examples', async function () {
    const ordinary = [
      '~~~tex',
      bs + 'xma',
      '~~~'
    ].join('\n')
    const ordinaryPos = ordinary.indexOf(bs + 'xma') + 4
    assert.equal(await completionFor(stateFor(ordinary), ordinaryPos), null)

    const raw = [
      '---',
      'tex:',
      '  packages: [mathtools]',
      '---',
      '~~~{=latex}',
      bs + 'xma',
      '~~~'
    ].join('\n')
    const rawPos = raw.indexOf(bs + 'xma') + 4
    const result = await completionFor(stateFor(raw), rawPos)
    assert.ok(optionLabels(result).includes(bs + 'xmapsto'))
  })

  it('works in LaTeX documents and Pandoc YAML header-includes', async function () {
    const latex = [
      bs + 'usepackage{mathtools}',
      bs + 'xma'
    ].join('\n')
    assert.ok(optionLabels(await completionFor(stateFor(latex, 'latex'))).includes(bs + 'xmapsto'))

    const yaml = [
      'tex:',
      '  packages: [mathtools]',
      'header-includes:',
      '  - ' + bs + 'xma'
    ].join('\n')
    assert.ok(optionLabels(await completionFor(stateFor(yaml, 'yaml'))).includes(bs + 'xmapsto'))
  })

  it('does not interpret unrelated YAML or frontmatter strings as TeX', async function () {
    const yaml = [
      'tex:',
      '  packages: [mathtools]',
      'windows-path: C:' + bs + 'Users' + bs + 'notes',
      'other: ' + bs + 'xma',
      'header-includes:',
      '  - ' + bs + 'xma'
    ].join('\n')
    const otherPos = yaml.indexOf('other: ') + 'other: '.length + 4
    const headerPos = yaml.lastIndexOf(bs + 'xma') + 4
    assert.equal(await completionFor(stateFor(yaml, 'yaml'), otherPos), null)
    assert.ok(optionLabels(await completionFor(stateFor(yaml, 'yaml'), headerPos)).includes(bs + 'xmapsto'))

    const markdown = [
      '---',
      'tex:',
      '  packages: [mathtools]',
      'title: ' + bs + 'notATeXCommand',
      'header-includes:',
      '  - ' + bs + 'usepackage{mathtools}',
      '---',
      '$' + bs + 'xmapsto$'
    ].join('\n')
    const diagnostics = texCommandDiagnostics(stateFor(markdown))
    assert.equal(diagnostics.some(diagnostic => diagnostic.message.includes('notATeXCommand')), false)
  })

  it('does not interpret path fragments as raw TeX commands in Markdown', async function () {
    const doc = 'Windows path C:' + bs + 'Users' + bs + 'notes and prose.'
    const state = stateFor(doc)
    assert.equal(texCommandDiagnostics(state).length, 0)
    const pos = doc.indexOf(bs + 'Users') + 4
    assert.equal(await completionFor(state, pos), null)
  })

  it('accepts authority-supplied user macros and packages', async function () {
    const macroSource = {
      path: '/notes/tex/macros.sty',
      content: [
        bs + 'RequirePackage{mathtools}',
        bs + 'DeclareMathOperator{' + bs + 'Pic}{Pic}'
      ].join('\n')
    }
    const pic = '$' + bs + 'Pi'
    const state = stateFor(pic, 'markdown', [ macroSource ])
    const labels = optionLabels(await completionFor(state))
    assert.ok(labels.includes(bs + 'Pic'))
    assert.ok(labels.includes(bs + 'xmapsto'))
    assert.equal(texCommandDiagnostics(stateFor('$' + bs + 'Pic$', 'markdown', [ macroSource ])).length, 0)
  })

  it('keeps prose dictionaries out of backslash command contexts', async function () {
    const phraseState = EditorState.create({
      doc: bs + 'Sm',
      extensions: [
        markdownParser({ zknLinkParserConfig: { format: 'link|title' } }),
        phraseCompletionsField.init(() => [
          { text: 'Smith-Minkowski-Siegel', source: 'math.txt' }
        ])
      ]
    })
    const phraseResult = await phraseCompletionSource(new CompletionContext(
      phraseState,
      phraseState.doc.length,
      true
    ))
    assert.equal(phraseResult, null)
  })
})

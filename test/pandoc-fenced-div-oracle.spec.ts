/**
 * Differential oracle for Pandoc fenced-div opening syntax.
 *
 * The editor parser is intentionally not its own specification. Pandoc's
 * Markdown reader is the oracle for whether a fenced opening is admitted and
 * for the resulting Attr triple (id, classes, key/value pairs).
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { divModelFromNode } from 'source/common/pandoc-util/pandoc-div-model'
import { execPandocReference } from './pandoc-reference'

interface OracleAttr {
  id: string
  classes: string[]
  properties: Record<string, string>
}

function pandocDivAttr (source: string): OracleAttr|undefined {
  const raw = execPandocReference([ '-f', 'markdown', '-t', 'json' ], { input: source })
  const document = JSON.parse(raw) as { blocks: Array<{ t: string, c?: unknown }> }
  const block = document.blocks[0]
  if (block?.t !== 'Div' || !Array.isArray(block.c)) {
    return undefined
  }
  const attr = block.c[0] as [string, string[], Array<[string, string]>]
  return {
    id: attr[0],
    classes: attr[1],
    properties: Object.fromEntries(attr[2]),
  }
}

function editorDivAttr (source: string): OracleAttr|undefined {
  const state = EditorState.create({ doc: source, extensions: [ markdownParser() ] })
  const tree = ensureSyntaxTree(state, source.length, 5000)
  assert.ok(tree !== null, 'editor document must parse fully before differential comparison')
  const node = tree.topNode.getChild('PandocDiv')
  if (node === null) {
    return undefined
  }
  const model = divModelFromNode(state.doc, node)
  if (model === undefined) {
    return undefined
  }
  return {
    id: model.id,
    classes: model.classes,
    properties: model.properties,
  }
}

const cases = [
  {
    name: 'multiline theorem attributes with nested citation braces',
    source: `:::{.theorem
    title="{\\cite[Thm. 1.1]{AEGS25}}"
    #thm:intro-main-theorem
}
Body.
:::
`,
  },
  {
    name: 'ordinary single-line attributes',
    source: '::: {.definition #def-core title="Core object"}\nBody.\n:::\n',
  },
  {
    name: 'definition title braces and colon-qualified identifier',
    source: ':::{.definition title="{Symmetric Bilinear Form}" #def:symmetric-bilinear-form}\n\nBody.\n:::\n',
  },
  {
    name: 'definition ending directly after a bullet list',
    source: ':::{.definition title="{Symmetric Bilinear Form}" #def:symmetric-bilinear-form}\n\nIntro.\n\n- one\n- two\n:::\n',
  },
  {
    name: 'quoted character references and escaped ampersands',
    source: '::: {.theorem #thm-entities title="A &amp; B \\&amp; C"}\nBody.\n:::\n',
  },
  {
    name: 'bare class spelling',
    source: '::: Warning\nBody.\n:::\n',
  },
  {
    name: 'trailing colon decoration after attributes',
    source: ':::: {.lemma #lem-core} ::::::\nBody.\n::::\n',
  },
  {
    name: 'id/class key-value aliases and special unnumbered attribute',
    source: '::: {id=thm-alias class="theorem featured" -}\nBody.\n:::\n',
  },
  {
    name: 'malformed unquoted value containing spaces',
    source: '::: {key=some long value}\nBody.\n:::\n',
  },
  {
    name: 'unknown bare token inside braced attributes',
    source: '::: {#x .theorem unsupported-token}\nBody.\n:::\n',
  },
  {
    name: 'unclosed multiline attribute list',
    source: '::: {.theorem\n  #thm-unclosed\nBody.\n:::\n',
  },
] as const

describe('Pandoc fenced-div parser differential oracle', function () {
  this.timeout(30000)

  it('has a working Pandoc oracle', function () {
    assert.match(execPandocReference([ '--version' ]), /^pandoc 3\.10\.2\b/)
  })

  for (const testCase of cases) {
    it(`matches Pandoc for ${testCase.name}`, function () {
      assert.deepEqual(editorDivAttr(testCase.source), pandocDivAttr(testCase.source))
    })
  }
})

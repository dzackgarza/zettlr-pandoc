/**
 * Differential oracle for the remaining Pandoc-owned syntax in the vendored
 * Lezer fork. Feature-specific suites cover fenced divs, citations, tables,
 * math, and raw TeX; this suite covers spans, footnotes, wikilinks, ordinary
 * links, YAML metadata, and the Pandoc inline/list extensions reused from
 * upstream Lezer.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918.
 */

import { strict as assert } from 'node:assert'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { execPandocReference } from './pandoc-reference'

const READER = [
  'markdown',
  '+bracketed_spans',
  '+footnotes',
  '+inline_notes',
  '+wikilinks_title_after_pipe'
].join('')

function pandocDocument (source: string): unknown {
  return JSON.parse(execPandocReference(['-f', READER, '-t', 'json'], { input: source })) as unknown
}

function pandocTypeCount (document: unknown, type: string): number {
  let count = 0
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (record.t === type) count++
    for (const child of Object.values(record)) visit(child)
  }
  visit(document)
  return count
}

function pandocTaskMarkerCount (document: unknown): number {
  let count = 0
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (record.t === 'Str' && (record.c === '☐' || record.c === '☒')) count++
    for (const child of Object.values(record)) visit(child)
  }
  visit(document)
  return count
}

function editorNodeCount (source: string, nodeName: string): number {
  const state = EditorState.create({
    doc: source,
    extensions: [markdownParser({ zknLinkParserConfig: { format: 'link|title' } })]
  })
  let count = 0
  syntaxTree(state).iterate({
    enter (node) {
      if (node.name === nodeName) count++
    }
  })
  return count
}

function editorNodeRanges (source: string, nodeName: string): Array<{ from: number, to: number }> {
  const state = EditorState.create({
    doc: source,
    extensions: [markdownParser({ zknLinkParserConfig: { format: 'link|title' } })]
  })
  const ranges: Array<{ from: number, to: number }> = []
  syntaxTree(state).iterate({
    enter (node) {
      if (node.name === nodeName) ranges.push({ from: node.from, to: node.to })
    }
  })
  return ranges
}

function pandocMetaKeys (document: unknown): string[] {
  if (typeof document !== 'object' || document === null) return []
  const meta = (document as { meta?: unknown }).meta
  return typeof meta === 'object' && meta !== null ? Object.keys(meta).sort() : []
}

describe('Pandoc core syntax differential oracle', function () {
  this.timeout(60000)

  it('matches bracketed-span admission and its immediate-attribute boundary', function () {
    for (const source of [
      '[small]{.smallcaps #x}',
      '[nested *content*]{#id .feature}',
      '[small] {.not-a-span}'
    ]) {
      const pandoc = pandocDocument(source)
      assert.equal(editorNodeCount(source, 'PandocSpan'), pandocTypeCount(pandoc, 'Span'), source)
    }
  })

  it('matches reference and inline footnote admission', function () {
    for (const source of [
      'Text[^a].\n\n[^a]: Note body.\n',
      'Text ^[inline *note*].',
      'Not a note [^bad id].'
    ]) {
      const pandoc = pandocDocument(source)
      assert.equal(editorNodeCount(source, 'Footnote'), pandocTypeCount(pandoc, 'Note'), source)
    }
  })

  it('matches wikilinks_title_after_pipe admission', function () {
    for (const source of [
      '[[Target|Shown]]',
      '[[Target]]',
      '[[Target\nShown]]'
    ]) {
      const pandoc = pandocDocument(source)
      const wikilinks = pandocTypeCount(pandoc, 'Link')
      assert.equal(editorNodeCount(source, 'ZknLink'), wikilinks, source)
    }
  })

  it('matches Pandoc ordinary-link admission for readable destinations', function () {
    for (const source of [
      '[label]()',
      '[label](my file.md "Title")',
      '[label](path(with-parens).md)',
      '[label](https://example.com/a%20b)'
    ]) {
      const pandoc = pandocDocument(source)
      assert.equal(editorNodeCount(source, 'Link'), pandocTypeCount(pandoc, 'Link'), source)
    }
  })

  it('matches YAML metadata-block admission and keys', function () {
    const valid = '---\ntitle: Hello\nauthor: Zack\n---\n\nBody\n'
    const validPandoc = pandocDocument(valid)
    assert.equal(editorNodeCount(valid, 'YAMLFrontmatter'), 1)
    assert.deepEqual(pandocMetaKeys(validPandoc), ['author', 'title'])

    const laterMetadata = 'Before\n\n---\ntitle: Later\n---\n'
    assert.equal(editorNodeCount(laterMetadata, 'YAMLFrontmatter'), 1)
    assert.deepEqual(editorNodeRanges(laterMetadata, 'YAMLFrontmatter'), [{
      from: laterMetadata.indexOf('---'),
      to: laterMetadata.length - 1
    }])
    assert.deepEqual(pandocMetaKeys(pandocDocument(laterMetadata)), ['title'])

    // `---` followed by a blank line is Pandoc's horizontal-rule boundary,
    // not a YAML metadata opener (`yamlMetaBlock`'s notFollowedBy blankline).
    const horizontalRule = '---\n\nBody\n'
    assert.equal(editorNodeCount(horizontalRule, 'YAMLFrontmatter'), 0)
    assert.deepEqual(pandocMetaKeys(pandocDocument(horizontalRule)), [])
  })

  it('matches Pandoc strikeout, superscript, and subscript nodes', function () {
    const source = '~~strike~~ x^2^ H~2~O'
    const pandoc = pandocDocument(source)
    assert.equal(editorNodeCount(source, 'Strikethrough'), pandocTypeCount(pandoc, 'Strikeout'))
    assert.equal(editorNodeCount(source, 'Superscript'), pandocTypeCount(pandoc, 'Superscript'))
    assert.equal(editorNodeCount(source, 'Subscript'), pandocTypeCount(pandoc, 'Subscript'))
  })

  it('matches Pandoc task-list marker admission', function () {
    const source = '- [ ] todo\n- [x] done\n- ordinary\n'
    const pandoc = pandocDocument(source)
    assert.equal(editorNodeCount(source, 'Task'), pandocTaskMarkerCount(pandoc))
  })
})

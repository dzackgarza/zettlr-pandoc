/**
 * Language-level differential torture suite for the vendored Pandoc Lezer fork.
 *
 * This is intentionally not a collection of expected trees written by hand.
 * Pandoc 3.10.2 is the oracle. The same generated source is parsed by Pandoc
 * and by the editor grammar, both trees are projected to the same semantic
 * representation, and the projections must agree.
 *
 * The generated corpus stresses nesting, adjacency, physical-line boundaries,
 * block interruption, delimiter collisions, and combinations of otherwise
 * independently valid constructs. A parser change that only satisfies one
 * feature fixture is therefore not enough to keep this test green.
 */

import { strict as assert } from 'node:assert'
import { markdownToAST } from 'source/common/modules/markdown-utils'
import type {
  ASTNode,
  Document,
  Table,
} from 'source/common/modules/markdown-utils/markdown-ast'
import { mathFromCodeNode } from 'source/common/util/math-delimiters'
import { PANDOC_INLINE_COMMAND_NAMES } from '../vendor/lezer-markdown-pandoc/src/pandoc/pandoc-inline-commands'
import {
  PANDOC_INLINE_COMMAND_STRATEGIES,
  type PandocInlineCommandStrategy,
} from '../vendor/lezer-markdown-pandoc/src/pandoc/pandoc-inline-command-strategies'
import { execPandocReference } from './pandoc-reference'

const PANDOC_READER = [
  'markdown',
  '+fenced_divs',
  '+raw_tex',
  '+tex_math_dollars',
  '+tex_math_single_backslash',
  '+wikilinks_title_after_pipe',
  '+bracketed_spans',
  '+pipe_tables',
  '+grid_tables',
  '+footnotes',
  '+inline_notes',
].join('')

type Canon = string | { k: string, [key: string]: unknown }

type PandocNode = { t?: string, c?: unknown }

type Attr = [string, string[], Array<[string, string]>]

const MERGED_INLINE_KINDS = new Set(['Emph', 'Strong', 'Strikeout', 'Superscript', 'Subscript'])

function compactInlineCanon (items: Canon[]): Canon[] {
  const result: Canon[] = []
  for (const item of items) {
    const previous = result[result.length - 1]
    if (
      typeof item === 'object' && item !== null &&
      typeof previous === 'object' && previous !== null &&
      item.k === previous.k && MERGED_INLINE_KINDS.has(item.k) &&
      typeof item.text === 'string' && typeof previous.text === 'string'
    ) {
      previous.text = `${previous.text}${item.text}`
      if (Array.isArray(previous.c) && Array.isArray(item.c)) previous.c.push(...item.c)
      continue
    }
    result.push(item)
  }
  return result
}

function normalizeText (value: string): string {
  return value
    // Pandoc's default markdown reader performs reader-level smart punctuation
    // and resolves ordinary Markdown escapes. Neither transformation changes
    // the syntactic ownership we are comparing here, so normalize both trees
    // back to source-like text before comparing semantic structure.
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu, '$1')
    .replace(/—/gu, '---')
    .replace(/–/gu, '--')
    .replace(/…/gu, '...')
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function normalizeMath (value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim()
}

function canonicalUrl (value: string): string {
  const stripped = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value
  try {
    return decodeURI(stripped)
  } catch {
    return stripped
  }
}

function canonicalAttr (attr: Attr): { id: string, classes: string[], kv: Array<[string, string]> } {
  return {
    id: attr[0],
    classes: attr[1],
    kv: [...attr[2]].sort(([a], [b]) => a.localeCompare(b)),
  }
}

function editorAttr (attributes: Record<string, unknown>): { id: string, classes: string[], kv: Array<[string, string]> } {
  const id = typeof attributes.id === 'string' ? attributes.id : ''
  const rawClasses = attributes.class
  const classes = Array.isArray(rawClasses)
    ? rawClasses.filter((value): value is string => typeof value === 'string')
    : typeof rawClasses === 'string' && rawClasses !== '' ? rawClasses.split(/\s+/u) : []
  const kv = Object.entries(attributes)
    .filter(([key, value]) => key !== 'id' && key !== 'class' && typeof value === 'string')
    .map(([key, value]) => [key, value as string] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))
  return { id, classes, kv }
}

function pandocPlain (value: unknown): string {
  if (Array.isArray(value)) return value.map(pandocPlain).join('')
  if (typeof value !== 'object' || value === null) return ''
  const node = value as PandocNode
  switch (node.t) {
    case 'Str': return typeof node.c === 'string' ? node.c : ''
    case 'Space':
    case 'SoftBreak':
    case 'LineBreak': return ' '
    case 'Code': return Array.isArray(node.c) && typeof node.c[1] === 'string' ? node.c[1] : ''
    case 'Math': return Array.isArray(node.c) && typeof node.c[1] === 'string' ? node.c[1] : ''
    case 'RawInline': return Array.isArray(node.c) && typeof node.c[1] === 'string' ? node.c[1] : ''
    case 'Link':
    case 'Image': return Array.isArray(node.c) ? pandocPlain(node.c[1]) : ''
    case 'Cite': return Array.isArray(node.c) ? pandocPlain(node.c[1]) : ''
    case 'Note': return ''
    case 'Span': return Array.isArray(node.c) ? pandocPlain(node.c[1]) : ''
    case 'Quoted': {
      if (!Array.isArray(node.c)) return ''
      const quoteKind = citationMode(node.c[0])
      const mark = quoteKind === 'SingleQuote' ? "'" : '"'
      return `${mark}${pandocPlain(node.c[1])}${mark}`
    }
    default: return pandocPlain(node.c)
  }
}

function editorChildren (node: ASTNode): ASTNode[] {
  if ('children' in node) return node.children
  if ('items' in node) return node.items
  return []
}

const SYNTAX_ONLY_GENERIC = /(?:Mark|Delimiter|Attribute|Info)$/u

function editorPlain (nodes: ASTNode[], source: string): string {
  let text = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'Text':
        text += `${node.whitespaceBefore}${node.value}`
        break
      case 'InlineCode':
        text += node.source
        break
      case 'RawInline':
        text += node.source
        break
      case 'Link':
      case 'Image':
        text += node.alt.value
        break
      case 'ZettelkastenLink':
        text += node.title?.value ?? node.target
        break
      case 'ZettelkastenTag':
        // Application-only editor syntax. It must remain text-identical in the
        // Pandoc projection even though Pandoc has no corresponding AST node.
        text += source.slice(node.from, node.to)
        break
      case 'Citation':
        text += node.value
        break
      case 'Footnote':
        break
      case 'PandocSpan':
      case 'Emphasis':
      case 'Strikethrough':
      case 'Superscript':
      case 'Subscript':
      case 'Highlight':
        text += editorPlain(node.children, source)
        break
      case 'Generic':
        if (node.name === 'Link' || node.name === 'Image') {
          // URL-less Lezer Link/Image nodes are syntax-recovery wrappers, not
          // semantic Pandoc links. Pandoc preserves their authored punctuation
          // literally while still parsing semantic children inside. Preserve
          // only the wrapper marks literally; recursively normalize content so
          // emphasis/citations inside the fallback agree with Pandoc's AST.
          for (const child of node.children) {
            if (child.type === 'Generic' && (child.name === 'LinkMark' || child.name === 'LinkLabel')) {
              if (child.name === 'LinkMark') {
                text += source.slice(child.from, child.to)
              } else {
                text += editorPlain(child.children, source)
              }
            } else {
              text += editorPlain([child], source)
            }
          }
        } else if (!SYNTAX_ONLY_GENERIC.test(node.name)) {
          if (node.children.length > 0) text += editorPlain(node.children, source)
          else text += source.slice(node.from, node.to)
        }
        break
    }
  }
  return text
}

function citationMode (value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  return String((value as { t?: string }).t ?? '')
}

function pandocInlineCanon (value: unknown): Canon[] {
  if (!Array.isArray(value)) return []
  const result: Canon[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as PandocNode
    switch (node.t) {
      case 'Str':
      case 'Space':
      case 'SoftBreak':
      case 'LineBreak':
        break
      case 'Emph':
        result.push({ k: 'Emph', text: normalizeText(pandocPlain(node.c)), c: pandocInlineCanon(node.c) })
        break
      case 'Strong':
        result.push({ k: 'Strong', text: normalizeText(pandocPlain(node.c)), c: pandocInlineCanon(node.c) })
        break
      case 'Strikeout':
        result.push({ k: 'Strikeout', text: normalizeText(pandocPlain(node.c)), c: pandocInlineCanon(node.c) })
        break
      case 'Superscript':
        result.push({ k: 'Superscript', text: normalizeText(pandocPlain(node.c)), c: pandocInlineCanon(node.c) })
        break
      case 'Subscript':
        result.push({ k: 'Subscript', text: normalizeText(pandocPlain(node.c)), c: pandocInlineCanon(node.c) })
        break
      case 'Code':
        result.push({ k: 'Code', text: Array.isArray(node.c) ? node.c[1] : '' })
        break
      case 'Math': {
        if (!Array.isArray(node.c)) break
        result.push({
          k: 'Math',
          display: citationMode(node.c[0]) === 'DisplayMath',
          text: normalizeMath(String(node.c[1] ?? '')),
        })
        break
      }
      case 'RawInline':
        if (Array.isArray(node.c)) result.push({ k: 'RawInline', format: node.c[0], text: node.c[1] })
        break
      case 'Link':
      case 'Image': {
        if (!Array.isArray(node.c)) break
        const target = Array.isArray(node.c[2]) ? node.c[2] : ['', '']
        result.push({
          k: node.t,
          attr: canonicalAttr(node.c[0] as Attr),
          text: normalizeText(pandocPlain(node.c[1])),
          url: canonicalUrl(String(target[0] ?? '')),
          title: String(target[1] ?? ''),
          c: pandocInlineCanon(node.c[1]),
        })
        break
      }
      case 'Span':
        if (Array.isArray(node.c)) result.push({
          k: 'Span',
          attr: canonicalAttr(node.c[0] as Attr),
          text: normalizeText(pandocPlain(node.c[1])),
          c: pandocInlineCanon(node.c[1]),
        })
        break
      case 'Cite': {
        if (!Array.isArray(node.c)) break
        const citations = Array.isArray(node.c[0]) ? node.c[0] : []
        result.push({
          k: 'Cite',
          items: citations.map(item => {
            const citation = item as Record<string, unknown>
            return {
              id: String(citation.citationId ?? ''),
              mode: citationMode(citation.citationMode),
            }
          }),
        })
        break
      }
      case 'Note':
        result.push({ k: 'Note', text: normalizeText(pandocPlain(node.c)) })
        break
      default:
        result.push(...pandocInlineCanon(Array.isArray(node.c) ? node.c : []))
        break
    }
  }
  return compactInlineCanon(result)
}

function pandocTableSummary (node: PandocNode): Canon {
  const c = Array.isArray(node.c) ? node.c : []
  const colspecs = Array.isArray(c[2]) ? c[2] : []
  const alignment = colspecs.map(spec => {
    if (!Array.isArray(spec)) return null
    switch (citationMode(spec[0])) {
      case 'AlignLeft': return 'left'
      case 'AlignCenter': return 'center'
      case 'AlignRight': return 'right'
      default: return null
    }
  })
  const rowText = (rows: unknown): string[][] => {
    if (!Array.isArray(rows)) return []
    return rows.map(row => {
      if (!Array.isArray(row) || !Array.isArray(row[1])) return []
      return row[1].map(cell => Array.isArray(cell) ? normalizeText(pandocPlain(cell[4])) : '')
    })
  }
  const head = Array.isArray(c[3]) ? rowText(c[3][1]) : []
  const body: string[][] = []
  if (Array.isArray(c[4])) {
    for (const tableBody of c[4]) {
      if (!Array.isArray(tableBody)) continue
      body.push(...rowText(tableBody[2]), ...rowText(tableBody[3]))
    }
  }
  return { k: 'Table', alignment, head, body }
}

function pandocBlocksCanon (blocks: unknown): Canon[] {
  if (!Array.isArray(blocks)) return []
  const result: Canon[] = []
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as PandocNode
    switch (node.t) {
      case 'Para':
      case 'Plain':
        result.push({
          k: 'TextBlock',
          text: normalizeText(pandocPlain(node.c)),
          c: pandocInlineCanon(node.c),
        })
        break
      case 'Header':
        if (Array.isArray(node.c)) {
          const attr = canonicalAttr(node.c[1] as Attr)
          // Pandoc materializes an automatic heading identifier in the AST.
          // Lezer intentionally leaves that source-absent semantic postprocess
          // to the reference layer, so it is outside grammar parity.
          attr.id = ''
          result.push({
            k: 'Header',
            level: node.c[0],
            attr,
            text: normalizeText(pandocPlain(node.c[2])),
            c: pandocInlineCanon(node.c[2]),
          })
        }
        break
      case 'Div':
        if (Array.isArray(node.c)) result.push({
          k: 'Div',
          attr: canonicalAttr(node.c[0] as Attr),
          c: pandocBlocksCanon(node.c[1]),
        })
        break
      case 'BlockQuote':
        result.push({ k: 'BlockQuote', c: pandocBlocksCanon(node.c) })
        break
      case 'BulletList':
        result.push({
          k: 'BulletList',
          items: Array.isArray(node.c) ? node.c.map(item => pandocBlocksCanon(item)) : [],
        })
        break
      case 'OrderedList':
        if (Array.isArray(node.c)) result.push({
          k: 'OrderedList',
          start: Array.isArray(node.c[0]) ? node.c[0][0] : 1,
          items: Array.isArray(node.c[1]) ? node.c[1].map(item => pandocBlocksCanon(item)) : [],
        })
        break
      case 'CodeBlock':
        if (Array.isArray(node.c)) result.push({
          k: 'CodeBlock',
          attr: canonicalAttr(node.c[0] as Attr),
          text: String(node.c[1] ?? ''),
        })
        break
      case 'RawBlock':
        if (Array.isArray(node.c)) result.push({ k: 'RawBlock', format: node.c[0], text: node.c[1] })
        break
      case 'Table':
        result.push(pandocTableSummary(node))
        break
      case 'HorizontalRule':
        result.push({ k: 'HorizontalRule' })
        break
      default:
        result.push({ k: String(node.t ?? 'Unknown') })
        break
    }
  }
  return result
}

function editorInlineCanon (nodes: ASTNode[], source: string): Canon[] {
  const result: Canon[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'Text':
        break
      case 'Emphasis':
        result.push({
          k: node.which === 'bold' ? 'Strong' : 'Emph',
          text: normalizeText(editorPlain(node.children, source)),
          c: editorInlineCanon(node.children, source),
        })
        break
      case 'Strikethrough':
        result.push({ k: 'Strikeout', text: normalizeText(editorPlain(node.children, source)), c: editorInlineCanon(node.children, source) })
        break
      case 'Superscript':
        result.push({ k: 'Superscript', text: normalizeText(editorPlain(node.children, source)), c: editorInlineCanon(node.children, source) })
        break
      case 'Subscript':
        result.push({ k: 'Subscript', text: normalizeText(editorPlain(node.children, source)), c: editorInlineCanon(node.children, source) })
        break
      case 'InlineCode': {
        const math = mathFromCodeNode(node.info, node.source)
        result.push(math === null
          ? { k: 'Code', text: node.source }
          : { k: 'Math', display: math.display, text: normalizeMath(math.equation) })
        break
      }
      case 'RawInline':
        result.push({ k: 'RawInline', format: node.format, text: node.source })
        break
      case 'Link':
      case 'Image':
        result.push({
          k: node.type,
          attr: editorAttr(node.attributes),
          text: normalizeText(node.alt.value),
          url: canonicalUrl(node.url),
          title: node.title?.value ?? '',
          c: [],
        })
        break
      case 'ZettelkastenLink':
        result.push({
          k: 'Link',
          attr: { id: '', classes: ['wikilink'], kv: [] },
          text: normalizeText(node.title?.value ?? node.target),
          url: node.target,
          title: '',
          c: [],
        })
        break
      case 'PandocSpan':
        result.push({
          k: 'Span',
          attr: editorAttr(node.attributes),
          text: normalizeText(editorPlain(node.children, source)),
          c: editorInlineCanon(node.children, source),
        })
        break
      case 'Citation':
        result.push({
          k: 'Cite',
          items: node.parsedCitation.items.map(item => ({
            id: item.id,
            mode: item['suppress-author'] === true ? 'SuppressAuthor' : node.parsedCitation.composite ? 'AuthorInText' : 'NormalCitation',
          })),
        })
        break
      case 'Footnote':
        {
          const ast = markdownToAST(node.label)
          const text = ast.type === 'Document'
            ? editorPlain(ast.children, node.label)
            : node.label
          result.push({ k: 'Note', text: normalizeText(text) })
        }
        break
      case 'Generic':
        if (!SYNTAX_ONLY_GENERIC.test(node.name)) result.push(...editorInlineCanon(node.children, source))
        break
      case 'Highlight':
        result.push(...editorInlineCanon(node.children, source))
        break
    }
  }
  return compactInlineCanon(result)
}

function editorTableSummary (table: Table, source: string): Canon {
  return {
    k: 'Table',
    alignment: table.alignment,
    head: table.rows.filter(row => row.isHeaderOrFooter).map(row => row.cells.map(cell => normalizeText(editorPlain(cell.children, source)))),
    body: table.rows.filter(row => !row.isHeaderOrFooter).map(row => row.cells.map(cell => normalizeText(editorPlain(cell.children, source)))),
  }
}

function editorBlocksCanon (nodes: ASTNode[], source: string): Canon[] {
  const result: Canon[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'Text':
        if (normalizeText(node.value) !== '') result.push({ k: 'TextBlock', text: normalizeText(node.value), c: [] })
        break
      case 'Generic':
        if (node.name === 'Paragraph') {
          result.push({ k: 'TextBlock', text: normalizeText(editorPlain(node.children, source)), c: editorInlineCanon(node.children, source) })
        } else if (node.name === 'Blockquote') {
          result.push({ k: 'BlockQuote', c: editorBlocksCanon(node.children, source) })
        } else if (node.name === 'HorizontalRule') {
          result.push({ k: 'HorizontalRule' })
        } else if (!SYNTAX_ONLY_GENERIC.test(node.name) && node.children.length > 0) {
          result.push(...editorBlocksCanon(node.children, source))
        }
        break
      case 'Heading':
        result.push({
          k: 'Header',
          level: node.level,
          attr: editorAttr(node.attributes),
          text: normalizeText(editorPlain(node.children, source)),
          c: editorInlineCanon(node.children, source),
        })
        break
      case 'PandocDiv':
        result.push({ k: 'Div', attr: editorAttr(node.attributes), c: editorBlocksCanon(node.children, source) })
        break
      case 'BulletList':
        result.push({ k: 'BulletList', items: node.items.map(item => editorBlocksCanon(item.children, source)) })
        break
      case 'OrderedList':
        result.push({ k: 'OrderedList', start: node.startsAt, items: node.items.map(item => editorBlocksCanon(item.children, source)) })
        break
      case 'FencedCode': {
        const math = mathFromCodeNode(node.info, node.source)
        const attr = editorAttr(node.attributes)
        if (math === null && node.info !== '' && !node.info.trimStart().startsWith('{')) {
          attr.classes = [node.info.trim().split(/\s+/u)[0]]
        }
        result.push(math === null
          ? { k: 'CodeBlock', attr, text: node.source }
          : { k: 'TextBlock', text: normalizeText(math.equation), c: [{ k: 'Math', display: math.display, text: normalizeMath(math.equation) }] })
        break
      }
      case 'RawBlock':
        result.push({ k: 'RawBlock', format: node.format, text: node.source })
        break
      case 'Table':
        result.push(editorTableSummary(node, source))
        break
      default:
        // Inline nodes can appear as top-level children in the editor's custom
        // AST in a few recovery situations. Normalize them through the same
        // inline projection rather than inventing another interpretation.
        result.push(...editorInlineCanon([node], source))
        break
    }
  }
  return result
}

function pandocJson (source: string): { meta: Record<string, unknown>, blocks: PandocNode[] } {
  return JSON.parse(execPandocReference(['-f', PANDOC_READER, '-t', 'json'], {
    input: source,
    maxBuffer: 16 * 1024 * 1024,
  })) as { meta: Record<string, unknown>, blocks: PandocNode[] }
}

interface TortureCase { name: string, source: string }

const INLINE_ATOMS = [
  ['emphasis', '*emphasis*'],
  ['strong', '**strong**'],
  ['strikeout', '~~strike~~'],
  ['superscript', 'x^2^'],
  ['subscript', 'H~2~O'],
  ['code-with-pipe', '`a|b`'],
  ['dollar-math', '$x+\\tau$'],
  ['backslash-math', '\\(x+y\\)'],
  ['raw-tex-inline', '\\textbf{raw}'],
  ['link-with-space', '[label](my file.md "Title")'],
  ['wikilink', '[[Target|Shown]]'],
  ['citation', '[@Wei94, p. 7]'],
  ['span', '[span *inside*]{.marked key="v"}'],
  ['image', '![alt](figure.png "Figure")'],
  ['inline-note', '^[note *inside*]'],
] as const

const INLINE_CONTEXTS: Array<[string, (atom: string, n: number) => string]> = [
  ['paragraph', atom => `prefix ${atom} suffix.`],
  ['heading', atom => `## Prefix ${atom} suffix`],
  ['blockquote', atom => `> prefix ${atom} suffix.`],
  ['bullet', atom => `- prefix ${atom} suffix.`],
  ['ordered', atom => `3. prefix ${atom} suffix.`],
  ['div', (atom, n) => `::: {#inner-${n} .example}\nprefix ${atom} suffix.\n:::`],
  ['span-wrapper', atom => `[prefix ${atom} suffix]{.outer}`],
  ['table-cell', atom => `| left | right |\n|---|---|\n| prefix ${atom} suffix | tail |`],
]

function generatedCases (): TortureCase[] {
  const cases: TortureCase[] = []
  let n = 0
  for (const [atomName, atom] of INLINE_ATOMS) {
    for (const [contextName, context] of INLINE_CONTEXTS) {
      // Links/images/wikilinks cannot nest in an outer Pandoc link-like span in
      // ways that preserve the same semantics, but ordinary bracketed spans are
      // valid around them. Keep every context here; the oracle decides.
      cases.push({ name: `${contextName}/${atomName}`, source: context(atom, n++) })
    }
  }

  const separators = ['', ' ', '; ', '\n']
  for (let left = 0; left < INLINE_ATOMS.length; left++) {
    for (let right = 0; right < INLINE_ATOMS.length; right++) {
      const separator = separators[(left + right) % separators.length]
      cases.push({
        name: `adjacent/${INLINE_ATOMS[left][0]}/${INLINE_ATOMS[right][0]}/${JSON.stringify(separator)}`,
        source: `before ${INLINE_ATOMS[left][1]}${separator}${INLINE_ATOMS[right][1]} after`,
      })
    }
  }

  const rawInlineForms = (
    name: string,
    strategy: PandocInlineCommandStrategy,
  ): ReadonlyArray<[string, string]> => {
    const command = `\\${name}`
    switch (strategy) {
      case 'zero': return [
        [ 'bare', `before ${command} after stop` ],
        [ 'does-not-own-following-group', `before ${command}{x} after stop` ],
      ]
      case 'raw-command': return [
        [ 'bare', `before ${command} after stop` ],
        [ 'raw-groups', `before ${command}{x}{y} after stop` ],
      ]
      case 'tok': return [[ 'tok', `before ${command}{x} after stop` ]]
      case 'optional-tok': return [
        [ 'empty', `before ${command} after stop` ],
        [ 'tok', `before ${command}{x} after stop` ],
      ]
      case 'two-tok': return [[ 'two-tok', `before ${command}{x}{y} after stop` ]]
      case 'braced':
      case 'skipopts-braced':
      case 'rawopts-one-braced':
        return [[ 'braced', `before ${command}{x} after stop` ]]
      case 'braced-tok':
      case 'braced-sp-tok':
        return [[ 'braced-tok', `before ${command}{x}{y} after stop` ]]
      case 'skipopts-tok':
        return [[ 'skipopts-tok', `before ${command}[opt]{x} after stop` ]]
      case 'optional-rawopt-tok':
        return [[ 'optional-rawopt-tok', `before ${command}[opt]{x} after stop` ]]
      case 'skipopts-braced-tok':
        return [[ 'skipopts-braced-tok', `before ${command}[opt]{x}{y} after stop` ]]
      case 'braced-skipopts-tok':
        return [[ 'braced-skipopts-tok', `before ${command}{en}[opt]{x} after stop` ]]
      case 'three-braced-inline':
        return [[ 'three-braced-inline', `before ${command}{x}{y}{z} after stop` ]]
      case 'optional-numeric-bracket':
        return [[ 'optional-number', `before ${command}[1] after stop` ]]
      case 'optional-numeric-bracket-group':
        return [[ 'optional-number-group', `before ${command}[1]{x} after stop` ]]
      case 'optional-bracket-braced':
        return [[ 'option-braced', `before ${command}[opt]{x} after stop` ]]
      case 'verbatim':
        return [[ 'verbatim', `before ${command}|x| after stop` ]]
      case 'optional-bracket-verbatim':
        return [[ 'option-verbatim', `before ${command}[language=tex]|x| after stop` ]]
      case 'skipopts-braced-verbatim':
        return [[ 'options-language-verbatim', `before ${command}[opt]{tex}|x| after stop` ]]
      case 'citation-single':
        return [[ 'citation', `before ${command}{Key} after stop` ]]
      case 'citation-multi':
        return [[ 'citations', `before ${command}{Key}{Other} after stop` ]]
      case 'citation-text':
        return [[ 'citation-text', `before ${command}{\\cite{Key}} after stop` ]]
      case 'citation-author':
        return [[ 'citation-author', `before ${command}{Key} after stop` ]]
      case 'skipopts-group':
        return [[ 'group', `before ${command}[opt]{x} after stop` ]]
      case 'roman':
        return [[ 'roman', `before ${command}{4} after stop` ]]
      case 'hyperref':
        return [[ 'hyperref', `before ${command}[target]{x} after stop` ]]
      case 'si-unit':
        return [[ 'si-unit', `before ${command}{m} after stop` ]]
      case 'si-value-unit':
        return [[ 'si-value-unit', `before ${command}{1}{m} after stop` ]]
      case 'si-list-unit':
        return [[ 'si-list-unit', `before ${command}{1;2}{m} after stop` ]]
      case 'si-range':
        return [[ 'si-range', `before ${command}{1}{2} after stop` ]]
      case 'si-range-unit':
        return [[ 'si-range-unit', `before ${command}{1}{2}{m} after stop` ]]
      case 'until-fi':
        return [[ 'until-fi', `before ${command} 1pt=1pt x\\fi after stop` ]]
      case 'inlines':
        return [[ 'inlines', `before ${command} text after stop` ]]
    }
  }
  for (const name of PANDOC_INLINE_COMMAND_NAMES) {
    const strategy = PANDOC_INLINE_COMMAND_STRATEGIES[name]
    assert.ok(strategy !== undefined, `missing generated strategy for ${name}`)
    for (const [ formName, source ] of rawInlineForms(name, strategy)) {
      cases.push({
        name: `raw-inline-control-word/${name}/${formName}`,
        source,
      })
    }
  }

  cases.push(
    {
      name: 'display-math/cases/no-blank-before',
      source: 'with\n$$\nF(x)=\\begin{cases}\nx,&x>0,\\\\\n0,&x\\le0.\n\\end{cases}\n$$\nafter [@Wei94].',
    },
    {
      name: 'display-math/aligned/backslash-delimiters',
      source: 'before\n\\[\n\\begin{aligned}\nx&=y\\\\\ny&=z\n\\end{aligned}\n\\]\nafter',
    },
    {
      name: 'nested-div/math-table-citation',
      source: '::: {#outer .theorem}\n## Result\n\n::: {#inner .proof}\n| object | value |\n|---|---|\n| $H_i(C)$ | `a|b` |\n\n$$\nx=\\begin{cases}1,&x>0,\\\\0,&x\\le0.\\end{cases}\n$$\n\nSee [@Wei94, p. 9].\n:::\n:::',
    },
    {
      name: 'raw-tex-between-markdown-blocks',
      source: 'Before.\n\\begin{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}\nAfter *emphasis*.',
    },
    {
      name: 'code-fence-containing-pandoc-looking-source',
      source: '```markdown\n::: {#not-a-div}\n$$x$$ [@not-a-cite]\n:::\n```',
    },
    {
      name: 'multiline-div-attributes',
      source: '::: {.definition\n#def-multiline\ntitle="A {nested} title"\ndata-x="a &amp; b"}\nBody $x$.\n:::',
    },
    {
      // Markdown.hs `listLine` and `listContinuation` both apply
      // `notFollowedByDivCloser`. A div closer immediately after a compact
      // list therefore belongs to `divFenceEnd`, never to the final list
      // item's paragraph.
      name: 'fenced-div/compact-list/direct-close',
      source: '::: {.definition #def-list-close}\nIntro.\n\n- one\n- two\n:::',
    },
    {
      // The same ownership rule applies after a loose list continuation.
      name: 'fenced-div/loose-list/direct-close',
      source: '::: {.definition #def-loose-list-close}\n- one\n\n  continuation\n\n- two\n:::',
    },
    {
      // An inner fenced div closing directly after a list must close the inner
      // div only; the outer div remains active until its own fence.
      name: 'nested-fenced-div/list/direct-close',
      source: '::: {.theorem #outer-list-close}\n::: {.proof #inner-list-close}\n- one\n- two\n:::\nOuter tail.\n:::',
    },
  )
  return cases
}

function seededRandom (seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function generatedInlineFuzzCases (count: number): TortureCase[] {
  const random = seededRandom(0x50414e44) // "PAND"
  const separators = ['', ' ', '; ', ', ', ' / ', ' — ']
  const cases: TortureCase[] = []

  for (let index = 0; index < count; index++) {
    const atomCount = 2 + (random() % 5)
    const pieces: string[] = []
    const names: string[] = []
    for (let atomIndex = 0; atomIndex < atomCount; atomIndex++) {
      const [name, source] = INLINE_ATOMS[random() % INLINE_ATOMS.length]
      names.push(name)
      pieces.push(source)
      if (atomIndex + 1 < atomCount) {
        pieces.push(separators[random() % separators.length])
      }
    }
    const [contextName, context] = INLINE_CONTEXTS[random() % INLINE_CONTEXTS.length]
    cases.push({
      name: `fuzz-inline/${index}/${contextName}/${names.join('+')}`,
      source: context(pieces.join(''), 10_000 + index),
    })
  }
  return cases
}

const BLOCK_ATOMS: ReadonlyArray<[string, (n: number) => string]> = [
  ['paragraph', n => `Paragraph ${n} with *emphasis*, $x_${n}$, and [@Wei94, p. ${1 + n % 9}].`],
  ['heading', n => `### Heading ${n} with $x_${n}$`],
  ['dollar-display', n => `$$\nF_${n}(x)=\\begin{cases}\nx,&x>0,\\\\\n0,&x\\le0.\n\\end{cases}\n$$`],
  ['backslash-display', n => `\\[\nx_${n}+y_${n}\n\\]`],
  ['pipe-table', n => `| object | value |\n|---|---|\n| $H_${n}(C)$ | \\textbf{raw} |`],
  ['grid-table', n => `+-----+-----+\n| a${n}  | b${n}  |\n+=====+=====+\n| c${n}  | d${n}  |\n+-----+-----+`],
  ['blockquote', n => `> Quote ${n} with [span]{.marked} and [[Target${n}|Shown ${n}]].`],
  ['list', n => `- item ${n} with ~~strike~~\n- item ${n + 1} with x^2^ and H~2~O`],
  ['raw-tex', n => `\\begin{tikzpicture}\n\\node {${n}};\n\\end{tikzpicture}`],
  ['nested-div', n => `::: {#nested-fuzz-${n} .example}\nNested ${n} with **strong** and \\(x_${n}\\).\n:::`],
  ['code-fence', n => `\`\`\`markdown\n::: {#literal-${n}}\n$$x_${n}$$ [@literal]\n:::\n\`\`\``],
]

function generatedBlockFuzzCases (count: number): TortureCase[] {
  const random = seededRandom(0x4c455a45) // "LEZE"
  const cases: TortureCase[] = []
  for (let index = 0; index < count; index++) {
    const blockCount = 2 + (random() % 5)
    const blocks: string[] = []
    const names: string[] = []
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
      const [name, build] = BLOCK_ATOMS[random() % BLOCK_ATOMS.length]
      names.push(name)
      blocks.push(build(index * 10 + blockIndex))
    }
    const separator = random() % 2 === 0 ? '\n' : '\n\n'
    cases.push({
      name: `fuzz-block/${index}/${names.join('+')}/${separator.length === 1 ? 'tight' : 'blank'}`,
      source: blocks.join(separator),
    })
  }
  return cases
}

const SENTINEL_PREFIX = 'PANDOC-TORTURE-SENTINEL-'

function batchSource (cases: TortureCase[]): string {
  // A fenced-div wrapper is not transparent: literal `:::` inside a case can
  // close the wrapper according to Pandoc's own grammar. A standalone HTML
  // comment separated by blank lines is a real top-level block in both trees
  // and does not put the case inside another Markdown container.
  return cases.map((testCase, index) => {
    return `${testCase.source}\n\n<!-- ${SENTINEL_PREFIX}${index} -->\n`
  }).join('\n')
}

function pandocSentinelIndex (block: PandocNode): number | undefined {
  if (block.t !== 'RawBlock' || !Array.isArray(block.c) || block.c[0] !== 'html') return undefined
  const source = String(block.c[1] ?? '')
  const match = new RegExp(`^<!-- ${SENTINEL_PREFIX}(\\d+) -->$`, 'u').exec(source)
  return match === null ? undefined : Number(match[1])
}

function splitPandocBatch (blocks: PandocNode[], count: number): PandocNode[][] {
  const result: PandocNode[][] = Array.from({ length: count }, () => [])
  let current = 0
  for (const block of blocks) {
    const sentinel = pandocSentinelIndex(block)
    if (sentinel !== undefined) {
      assert.equal(sentinel, current, `Pandoc sentinel order diverged at ${sentinel}, expected ${current}`)
      current++
      continue
    }
    assert.ok(current < count, 'Pandoc emitted content after the final torture sentinel')
    result[current].push(block)
  }
  assert.equal(current, count, `Pandoc emitted ${current}/${count} torture sentinels`)
  return result
}

function splitEditorBatch (document: Document, count: number): ASTNode[][] {
  const result: ASTNode[][] = Array.from({ length: count }, () => [])
  let current = 0
  for (const node of document.children) {
    const sentinel = node.type === 'Comment' && node.name === 'CommentBlock'
      ? new RegExp(`^${SENTINEL_PREFIX}(\\d+)$`, 'u').exec(node.value.trim())
      : null
    if (sentinel !== null) {
      const index = Number(sentinel[1])
      assert.equal(index, current, `Lezer sentinel order diverged at ${index}, expected ${current}`)
      current++
      continue
    }
    assert.ok(current < count, 'Lezer emitted content after the final torture sentinel')
    result[current].push(node)
  }
  assert.equal(current, count, `Lezer emitted ${current}/${count} torture sentinels`)
  return result
}

const MALFORMED_CASES: TortureCase[] = [
  { name: 'unclosed-dollar-inline', source: 'before $x after' },
  { name: 'unclosed-dollar-display', source: '$$\nunclosed\n\n## heading survives\n' },
  { name: 'unclosed-backslash-inline', source: 'before \\(x after' },
  { name: 'unclosed-backslash-display', source: '\\[\nunclosed\n\n## heading survives\n' },
  { name: 'unclosed-div', source: '::: {#x .definition}\nbody $x$' },
  { name: 'unclosed-span-attributes', source: '[span]{.x key="unterminated}' },
  { name: 'unclosed-link', source: '[label](destination' },
  { name: 'unclosed-wikilink', source: '[[Target|Shown' },
  { name: 'unclosed-citation', source: 'before [@Wei94, p. 2 after' },
  { name: 'unclosed-raw-environment', source: '\\begin{tikzpicture}\n\\draw (0,0)--(1,1);' },
  { name: 'malformed-table-delimiter', source: 'A|B\n--x|---\nC|D' },
  { name: 'yaml-opener-followed-by-blank', source: '---\n\nBody' },
  { name: 'div-close-inside-display-math', source: '::: {#x}\n$$\n::: not a div close\n$$\n:::' },
  { name: 'raw-block-opener-inside-display-math', source: '$$\n\\begin{figure}\nx\n\\end{figure}\n$$\nAfter.' },
]

function wholePandocCanon (source: string): Canon[] {
  return pandocBlocksCanon(pandocJson(source).blocks)
}

function wholeEditorCanon (source: string): Canon[] {
  const ast = markdownToAST(source, null, { zknLinkParserConfig: { format: 'link|title' } })
  assert.equal(ast.type, 'Document')
  return editorBlocksCanon((ast as Document).children, source)
}

describe('Pandoc language differential torture corpus', function () {
  this.timeout(120000)

  const validCases = [
    ...generatedCases(),
    ...generatedInlineFuzzCases(512),
    ...generatedBlockFuzzCases(128),
  ]
  assert.ok(validCases.length >= 980, `expected a large generated corpus, got ${validCases.length}`)

  // Do not concatenate a thousand adversarial documents into one giant parser
  // state. That measures incremental parser worst-case scaling more than
  // language parity and makes a single failure impossible to localize. Fixed
  // batches retain cross-case boundary pressure while keeping every failure
  // reproducible and bounded.
  const batchSize = 40
  for (let batchStart = 0; batchStart < validCases.length; batchStart += batchSize) {
    const batch = validCases.slice(batchStart, batchStart + batchSize)
    const batchEnd = batchStart + batch.length - 1
    it(`matches Pandoc AST projection for generated cases ${batchStart}-${batchEnd}`, function () {
      const source = batchSource(batch)
      const pandoc = pandocJson(source)
      const editor = markdownToAST(source, null, { zknLinkParserConfig: { format: 'link|title' } })
      assert.equal(editor.type, 'Document')
      const pandocCases = splitPandocBatch(pandoc.blocks, batch.length)
      const editorCases = splitEditorBatch(editor, batch.length)

      for (let index = 0; index < batch.length; index++) {
        assert.deepEqual(
          editorBlocksCanon(editorCases[index], source),
          pandocBlocksCanon(pandocCases[index]),
          `case ${batchStart + index}: ${batch[index].name}`,
        )
      }
    })
  }

  for (const testCase of MALFORMED_CASES) {
    it(`matches Pandoc recovery for ${testCase.name}`, function () {
      assert.deepEqual(wholeEditorCanon(testCase.source), wholePandocCanon(testCase.source))
    })
  }
})

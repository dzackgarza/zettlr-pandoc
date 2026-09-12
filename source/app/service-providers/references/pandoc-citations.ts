import { execFile } from 'node:child_process'
import { z } from 'zod'
import { markdownToAST, extractASTNodes } from '@common/modules/markdown-utils'
import { parseCitationSuffix, type Citation, type CiteItem } from '@common/modules/markdown-editor/parser/citation-parser'

const json = z.json()
type PandocJSON = z.infer<typeof json>
const citationItems = z.array(z.object({
  citationId: z.string(),
  citationPrefix: z.array(json),
  citationSuffix: z.array(json),
  citationMode: z.object({ t: z.enum(['NormalCitation', 'SuppressAuthor', 'AuthorInText']) })
}))
const documentSchema = z.object({ blocks: z.array(z.object({
  t: z.literal('Div'),
  c: z.tuple([
    z.tuple([z.string(), z.array(z.string()), z.array(z.tuple([z.string(), z.string()]))]),
    z.array(json)
  ])
})) })

function citationCandidates (source: string): Citation[] {
  return extractASTNodes(markdownToAST(source), 'Citation').flatMap(node =>
    node.type === 'Citation' ? [node.parsedCitation] : [])
}

function inlineText (value: PandocJSON): string {
  if (Array.isArray(value)) return value.map(inlineText).join('')
  if (value === null || typeof value !== 'object') return ''
  if (value.t === 'Str' && typeof value.c === 'string') return value.c
  if (value.t === 'Space' || value.t === 'SoftBreak' || value.t === 'LineBreak') return ' '
  if (value.t === 'Code' && Array.isArray(value.c) && typeof value.c[1] === 'string') return value.c[1]
  return value.c === undefined ? '' : inlineText(value.c)
}

const citationParagraph = z.array(z.object({
  t: z.literal('Para'),
  c: z.array(z.object({ t: z.literal('Cite'), c: z.tuple([citationItems, z.array(json)]) })).length(1)
})).length(1)

/**
 * Pandoc owns citation IDs, modes and affixes; the editor owns source ranges.
 * Indexed Divs retain those ranges without searching normalized Pandoc text.
 * The candidates come from the complete document tree, excluding code and metadata.
 * https://pandoc.org/MANUAL.html#citations
 * https://hackage.haskell.org/package/pandoc-types/docs/Text-Pandoc-Definition.html
 */
export async function extractPandocCitations (source: string): Promise<Citation[]> {
  const candidates = citationCandidates(source)
  if (candidates.length === 0) return []
  const sources = new Map(candidates.map((candidate, index) => [`citation-${index}`, candidate]))
  const fence = ':'.repeat(Math.max(3, ...Array.from(source.matchAll(/^:{3,}/gm), match => match[0].length + 1)))
  const input = candidates.map((candidate, index) =>
    `${fence} {#citation-${index}}\n${candidate.source}\n${fence}`).join('\n\n')
  const output = await new Promise<string>((resolve, reject) => {
    const process = execFile('pandoc', ['--from=markdown', '--to=json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error !== null) reject(error)
        else resolve(stdout)
      })
    if (process.stdin === null) throw new Error('Pandoc input stream is unavailable')
    process.stdin.on('error', reject)
    process.stdin.end(input)
  })
  const document = documentSchema.parse(JSON.parse(output))
  return document.blocks.flatMap(block => {
    const candidate = sources.get(block.c[0][0])
    if (candidate === undefined) throw new Error('Pandoc returned an unrecognized citation source range')
    const paragraph = citationParagraph.safeParse(block.c[1])
    // A candidate is replaceable only when Pandoc consumes its entire range.
    if (!paragraph.success) return []
    const cluster = paragraph.data[0].c[0].c[0]
    const items = cluster.map(item => {
      // CSL's locator is an interpretation of the Pandoc suffix. Reuse the
      // shared CSL locator adapter after Pandoc normalizes affixes.
      const result: CiteItem = { id: item.citationId, ...parseCitationSuffix(inlineText(item.citationSuffix)) }
      const prefix = inlineText(item.citationPrefix)
      if (prefix !== '') result.prefix = prefix
      if (item.citationMode.t === 'SuppressAuthor') result['suppress-author'] = true
      return result
    })
    return [{ ...candidate, items, composite: cluster[0].citationMode.t === 'AuthorInText' }]
  })
}

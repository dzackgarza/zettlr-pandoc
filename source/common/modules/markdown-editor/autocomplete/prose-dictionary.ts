/**
 * Prose dictionary completion. The main-process dictionary provider owns the
 * selected Hunspell vocabularies and portable user catalogue files; this
 * module keeps one renderer-local snapshot and never performs IPC per keypress.
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { isMathPosition } from '../util/is-math-position'
import { tikzBlockAt } from '../tikz-block'
import { withCompletionSource } from './completion-presentation'

interface ProseCatalogue {
  words: string[]
  phrases: string[]
}

let cached: ProseCatalogue|null = null
let loading: Promise<ProseCatalogue>|null = null

export function isProseCompletionPosition (state: EditorState, pos: number): boolean {
  if (isMathPosition(state, pos) || tikzBlockAt(state, pos) !== null) {
    return false
  }
  let node: SyntaxNode|null = syntaxTree(state).resolveInner(pos, -1)
  while (node !== null) {
    if (
      node.name === 'InlineCode' ||
      node.name === 'FencedCode' ||
      node.name === 'YAMLFrontmatter' ||
      node.name === 'YAMLFrontmatterStart' ||
      node.name === 'YAMLFrontmatterEnd'
    ) {
      return false
    }
    node = node.parent
  }
  return true
}

async function loadCatalogue (): Promise<ProseCatalogue> {
  if (cached !== null) return cached
  if (loading !== null) return await loading
  loading = window.ipc.invoke('dictionary-provider', { command: 'get-prose-completions' })
    .then((response) => {
      // Autocomplete is an additive convenience surface. A renderer starting
      // before the dictionary provider is ready (or a test seam that does not
      // implement this newer command) must not suppress snippets, citations,
      // buffer words, or any other source by rejecting the shared completion
      // session. Treat an unavailable/malformed catalogue as empty and let the
      // provider's later invalidation broadcast trigger a fresh load.
      const entries = Array.isArray(response)
        ? response.filter((entry): entry is string => typeof entry === 'string')
        : []
      const next: ProseCatalogue = { words: [], phrases: [] }
      for (const entry of entries) {
        if (/\s/u.test(entry)) next.phrases.push(entry)
        else next.words.push(entry)
      }
      cached = next
      return next
    })
    .finally(() => { loading = null })
  return await loading
}

type DictionaryBroadcast = {
  command: 'invalidate-dict'|'prose-completions-updated'
}

window.ipc.on('dictionary-provider', (_event, message: DictionaryBroadcast) => {
  if (message.command === 'prose-completions-updated' || message.command === 'invalidate-dict') {
    cached = null
  }
})

const WORD_FRAGMENT = /[\p{L}\p{N}'’_-]+$/u
const MAX_OPTIONS = 160

function phraseMatch (
  ctx: CompletionContext,
  phrases: string[]
): { from: number, fragment: string, options: Completion[] }|null {
  const line = ctx.state.doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  const floor = Math.max(0, before.length - 96)
  const starts: number[] = []
  for (let i = floor; i < before.length; i++) {
    if (i === 0 || /[\s([{—–,:;]/u.test(before[i - 1])) {
      starts.push(i)
    }
  }

  // Prefer the longest suffix which is already recognizably phrase-shaped.
  for (const start of starts) {
    const fragment = before.slice(start)
    if (!/\s/u.test(fragment) || fragment.trim().length < 3) continue
    const needle = fragment.toLocaleLowerCase()
    const matches = phrases
      .filter(entry => entry.toLocaleLowerCase().startsWith(needle))
      .slice(0, MAX_OPTIONS)
    if (matches.length > 0) {
      return {
        from: line.from + start,
        fragment,
        options: matches.map(label => withCompletionSource({ label, type: 'text', detail: 'prose phrase', boost: 15 }, 'Prose'))
      }
    }
  }
  return null
}

function wordOptions (entries: string[], query: string): Completion[] {
  const needle = query.toLocaleLowerCase()
  return entries
    .filter(entry => entry.toLocaleLowerCase().startsWith(needle))
    .slice(0, MAX_OPTIONS)
    .map(label => withCompletionSource({ label, type: 'text', detail: 'prose word' }, 'Prose'))
}

export const proseDictionarySource: CompletionSource = async (ctx): Promise<CompletionResult|null> => {
  if (!isProseCompletionPosition(ctx.state, ctx.pos)) {
    return null
  }

  const catalogue = await loadCatalogue()
  const phrase = phraseMatch(ctx, catalogue.phrases)
  if (phrase !== null) {
    return { from: phrase.from, options: phrase.options }
  }

  const word = ctx.matchBefore(WORD_FRAGMENT)
  if (word === null || (!ctx.explicit && word.text.length < 2)) {
    return null
  }

  const options = [
    ...catalogue.phrases
      .filter(entry => entry.toLocaleLowerCase().startsWith(word.text.toLocaleLowerCase()))
      .slice(0, 40)
      .map(label => withCompletionSource({ label, type: 'text', detail: 'prose phrase', boost: 10 }, 'Prose')),
    ...wordOptions(catalogue.words, word.text)
  ]
  return options.length === 0 ? null : { from: word.from, options }
}

/** Test seam for catalogue invalidation without reaching into module internals. */
export function __resetProseCompletionCacheForTests (): void {
  cached = null
  loading = null
}

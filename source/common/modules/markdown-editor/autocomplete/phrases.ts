import {
  ifNotIn,
  type CompletionContext,
  type CompletionSource
} from '@codemirror/autocomplete'
import { StateEffect, StateField } from '@codemirror/state'
import { type PhraseDictionaryEntry } from '../../../util/phrase-dictionary'
import { withCompletionSource } from './completion-presentation'

const nonProseNodes = [
  'FencedCode', 'CodeBlock', 'InlineCode', 'YAMLFrontmatter',
  'MathEquation', 'HTMLBlock', 'Comment', 'URL', 'LinkReference'
]

const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’.\-\u2010-\u2015]*/gu
const phrasePattern = /^[\p{L}\p{M}\p{N}'’. \-\u2010-\u2015]*$/u

function reservedPrefix (context: CompletionContext, from: number): boolean {
  return from > 0 && /[\\@#/:_\p{L}\p{M}\p{N}]/u.test(context.state.sliceDoc(from - 1, from))
}

/**
 * Dictionary updates arrive through the application's IPC and window store.
 * The completion source reads editor state, never the filesystem.
 */
export const phraseCompletionsUpdate = StateEffect.define<readonly PhraseDictionaryEntry[]>()

export const phraseCompletionsField = StateField.define<readonly PhraseDictionaryEntry[]>({
  create: () => [],
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(phraseCompletionsUpdate)) {return effect.value}
    }
    return value
  }
})

export const phraseCompletionSource: CompletionSource = ifNotIn(nonProseNodes, context => {
    const word = context.matchBefore(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’.\-\u2010-\u2015]* */u)
    if (word === null || reservedPrefix(context, word.from)) {return null}

    const entries = context.state.field(phraseCompletionsField)
    if (entries.length === 0) {return null}

    let from = word.from
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    // Range selection, not a new ranking engine: when completing "minimal mo",
    // replace both words, rather than inserting "minimal minimal model". On a
    // non-prefix query, leave the last word to CodeMirror's native fuzzy matcher.
    const foldedEntries = entries.map(entry => entry.text.toLowerCase())
    for (const candidate of before.matchAll(wordPattern)) {
      const start = line.from + candidate.index
      if (start > word.from) {break}
      if (reservedPrefix(context, start)) {continue}
      const prefix = before.slice(candidate.index).toLowerCase()
      if (foldedEntries.some(entry => entry.startsWith(prefix))) {
        from = start
        break
      }
    }

    if (!context.explicit && context.state.sliceDoc(from, context.pos).trim().length < 2) {return null}
    return {
      from,
      options: entries.map(entry => withCompletionSource({
        label: entry.text,
        apply: entry.text,
        type: 'text',
        detail: '[dictionary]',
        info: `${entry.text}\n\nDictionary: ${entry.source}`
      }, 'Dictionary')),
      // Spaces and hyphens must not terminate a phrase already being completed.
      // Native CodeMirror filtering, scoring, UI and insertion remain in charge.
      validFor: phrasePattern
    }
})

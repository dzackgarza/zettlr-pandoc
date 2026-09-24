import type {
  ExternalDiagnostic,
  ExternalLinter
} from '@common/diagnostics/external-linter'
import { trans } from '@common/i18n-renderer'
import { extractTextnodes, markdownToAST } from '@common/modules/markdown-utils'

export interface SpellcheckDiagnosticContext {
  autocorrectValues: string[]
}

const anyLetterRE = /[\p{L}'’‘]+/gu
const noneLetterRE = /^['’‘]+$/
const nonLetters = '\'’‘'
const spellcheckCache = new Map<string, boolean>()
let dictionaryListenerRegistered = false

function ensureDictionaryListener (): void {
  if (dictionaryListenerRegistered || window.ipc === undefined) {
    return
  }
  dictionaryListenerRegistered = true
  window.ipc.on('dictionary-provider', (_event, message) => {
    const payload = message as unknown as { command?: string }
    if (payload.command === 'invalidate-dict') {
      spellcheckCache.clear()
    }
  })
}

function sanitizeTerm (term: string): string {
  return term.replace(/’‘‚‹›»“”」/g, "'")
}

async function batchCheck (terms: string[]): Promise<void> {
  const pending = terms
    .map(term => sanitizeTerm(term))
    .filter(term => !spellcheckCache.has(term))
  if (pending.length === 0) {
    return
  }
  const correct: boolean[] | undefined = await window.ipc.invoke(
    'dictionary-provider',
    { command: 'check', terms: pending }
  )
  if (correct === undefined) {
    return
  }
  for (let index = 0; index < pending.length; index++) {
    spellcheckCache.set(pending[index], correct[index])
  }
}

async function check (
  term: string,
  autocorrectValues: string[]
): Promise<boolean> {
  const saneTerm = sanitizeTerm(term)
  if (autocorrectValues.includes(saneTerm)) {
    return true
  }
  const cached = spellcheckCache.get(saneTerm)
  if (cached !== undefined) {
    return cached
  }
  const correct: boolean[] | undefined = await window.ipc.invoke(
    'dictionary-provider',
    { command: 'check', terms: [saneTerm] }
  )
  if (correct === undefined) {
    return true
  }
  spellcheckCache.set(saneTerm, correct[0])
  return correct[0]
}

export const spellcheckDiagnosticProvider: ExternalLinter<SpellcheckDiagnosticContext> = {
  id: 'spellcheck',
  async run ({ text, context }) {
    ensureDictionaryListener()
    const ast = markdownToAST(text)
    const textNodes = extractTextnodes(ast)
    const wordsToCheck: Array<{ word: string, index: number, nodeStart: number }> =
      textNodes.flatMap(node => {
        const words: Array<{ index: number, word: string }> = []
        for (const match of node.value.matchAll(anyLetterRE)) {
          if (noneLetterRE.test(match[0])) {
            continue
          }
          let word = match[0]
          while (word.length > 0 && nonLetters.includes(word[0])) {
            word = word.slice(1)
          }
          while (word.length > 0 && nonLetters.includes(word[word.length - 1])) {
            word = word.slice(0, word.length - 1)
          }
          if (word !== '') {
            words.push({ word, index: match.index })
          }
        }
        return words.map(item => ({ ...item, nodeStart: node.from }))
      })

    await batchCheck(wordsToCheck.map(item => item.word))
    const diagnostics: ExternalDiagnostic[] = []
    for (const { word, index, nodeStart } of wordsToCheck) {
      if (await check(word, context.autocorrectValues)) {
        continue
      }
      diagnostics.push({
        from: nodeStart + index,
        to: nodeStart + index + word.length,
        message: trans('Spelling mistake'),
        severity: 'error',
        source: 'spellcheck'
      })
    }
    return { diagnostics }
  }
}

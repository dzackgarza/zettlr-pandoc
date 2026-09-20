import { reportError } from '@common/util/error-reporting'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import type { Command } from '@codemirror/view'
import type { QuickTexCatalogue } from '@dts/common/quicktex'

export const quickTexUpdate = StateEffect.define<QuickTexCatalogue>()

export const EMPTY_QUICKTEX: QuickTexCatalogue = {
  prose: {},
  math: {},
  excludeChars: ['{', '(', '['],
  sourceFile: '',
  diagnostics: []
}

export const quickTexField = StateField.define<QuickTexCatalogue>({
  create: () => EMPTY_QUICKTEX,
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(quickTexUpdate)) {
        return effect.value
      }
    }
    return value
  }
})

/** Port of quicktex#expand#ExpandWord's word extraction. */
function quickTexWord (
  state: EditorState,
  excludeChars: readonly string[]
): { word: string, from: number } | null {
  const pos = state.selection.main.head
  if (!state.selection.main.empty) {
    return null
  }
  const line = state.doc.lineAt(pos)
  const before = state.sliceDoc(line.from, pos)
  if (before === '') {
    return null
  }

  // The reference implementation treats a Space immediately before the cursor
  // as the special single-space key used to jump to the next <++> marker.
  if (before.endsWith(' ')) {
    return { word: ' ', from: pos - 1 }
  }

  let start = before.length
  while (start > 0 && !/\s/.test(before[start - 1])) {
    start--
  }
  const token = before.slice(start)
  const delimiter = excludeChars.reduce(
    (latest, character) => Math.max(latest, token.lastIndexOf(character)),
    -1
  )
  const word = token.slice(delimiter + 1)
  return word === '' ? null : { word, from: pos - word.length }
}

/** Direct port of quicktex#mathmode#InMathMode from the configured fork. */
function inQuickTexMathMode (state: EditorState, pos: number): boolean {
  let before = state.sliceDoc(0, pos).replaceAll('\\\\', '')
  const asymmetric: Array<[string, string]> = [
    ['\\(', '\\)'],
    ['\\[', '\\]'],
    ['\\begin{equation', '\\end{equation'],
    ['\\begin{displaymath', '\\end{displaymath'],
    ['\\begin{multline', '\\end{multline'],
    ['\\begin{gather', '\\end{gather'],
    ['\\begin{align', '\\end{align'],
  ]

  for (const [begin, end] of asymmetric) {
    before = before.slice(before.lastIndexOf(end) + 1)
    if (before.includes(begin)) {
      return true
    }
  }

  before = before.replace(/\\\$/g, '').replace(/\$\$/g, '$')
  return (before.length - before.replace(/\$/g, '').length) % 2 === 1
}

interface DecodedExpansion {
  insert: string
  deleteBefore: number
}

/** Decode Vim's keytrans() representation for the keycodes used by this QuickTeX config. */
function decodeExpansion (sequence: string): DecodedExpansion | null {
  let insert = ''
  let deleteBefore = 0
  for (let index = 0; index < sequence.length;) {
    if (sequence[index] !== '<') {
      insert += sequence[index++]
      continue
    }
    const end = sequence.indexOf('>', index + 1)
    if (end < 0) {
      insert += sequence[index++]
      continue
    }
    const token = sequence.slice(index, end + 1)
    if (token === '<lt>') {
      insert += '<'
    } else if (token === '<Space>') {
      insert += ' '
    } else if (token === '<CR>') {
      insert += '\n'
    } else if (token === '<Tab>') {
      insert += '\t'
    } else if (token === '<BS>') {
      if (insert.length > 0) {
        insert = insert.slice(0, -1)
      } else {
        deleteBefore++
      }
    } else {
      return null
    }
    index = end + 1
  }
  return { insert, deleteBefore }
}

/** Implements the fork's special `' '` entry: consume the next <+...+> marker. */
function jumpToNextMarker (
  state: EditorState,
  from: number
): { changes: { from: number, to: number, insert: string }, anchor: number } | null {
  const after = state.sliceDoc(from)
  const marker = /<\+[^\n]*?\+>/.exec(after)
  if (marker === null) {
    return null
  }
  const markerFrom = from + marker.index
  return {
    changes: { from: markerFrom, to: markerFrom + marker[0].length, insert: '' },
    anchor: markerFrom
  }
}

/**
 * QuickTeX's synchronous Space mapping. Exact hits consume Space and replace
 * the key with the evaluated result verbatim. Misses return false so the next
 * Space binding inserts the original trigger key, matching ExpandWord().
 */
export const expandQuickTexOnSpace: Command = view => {
  const catalogue = view.state.field(quickTexField, false)
  if (catalogue === undefined || catalogue.sourceFile === '') {
    return false
  }

  const match = quickTexWord(view.state, catalogue.excludeChars)
  if (match === null) {
    return false
  }

  const dictionary = inQuickTexMathMode(view.state, view.state.selection.main.head)
    ? catalogue.math
    : catalogue.prose
  const sequence = dictionary[match.word]
  if (sequence === undefined || sequence === '') {
    // Reference QuickTeX returns the original trigger key here. Returning false
    // delegates to CodeMirror's ordinary Space insertion, which is identical.
    return false
  }

  if (match.word === ' ' && sequence.includes('<Esc>')) {
    const jump = jumpToNextMarker(view.state, match.from)
    if (jump === null) {
      return false
    }
    view.dispatch({
      changes: [
        { from: match.from, to: match.from + 1, insert: '' },
        jump.changes
      ],
      selection: { anchor: jump.anchor - 1 },
      scrollIntoView: true
    })
    return true
  }

  const decoded = decodeExpansion(sequence)
  if (decoded === null) {
    reportError(`[QuickTeX] Can't expand ${JSON.stringify(match.word)}: its replacement contains unsupported Vim keycodes.`)
    return false
  }

  const from = Math.max(view.state.doc.lineAt(match.from).from, match.from - decoded.deleteBefore)
  let insert = decoded.insert
  let anchor = from + insert.length

  // ExpandWord's jumpBack deletes <+++> after insertion and leaves the cursor
  // at its start. Other <++> markers stay authored for the later Space jump.
  const jumpBack = insert.lastIndexOf('<+++>')
  if (jumpBack >= 0) {
    insert = insert.slice(0, jumpBack) + insert.slice(jumpBack + '<+++>'.length)
    anchor = from + jumpBack
  }

  view.dispatch({
    changes: { from, to: view.state.selection.main.head, insert },
    selection: { anchor },
    scrollIntoView: true
  })
  return true
}

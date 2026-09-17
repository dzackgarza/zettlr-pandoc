/** Emoji completion remains separate from the portable snippet subsystem. */
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { gemoji } from 'gemoji'
import type { AutocompletePlugin } from '.'
import { configField } from '../util/configuration'

function applyEmoji (view: EditorView, completion: Completion, from: number, to: number): void {
  view.dispatch({
    changes: [{ from: from - 1, to, insert: completion.label }],
    selection: { anchor: from - 1 + completion.label.length }
  })
}

const entries: Completion[] = gemoji.map(emoji => ({
  label: emoji.emoji,
  detail: emoji.names.join(', '),
  section: emoji.category,
  info: emoji.tags.join(', '),
  apply: applyEmoji
}))

export const emojis: AutocompletePlugin = {
  source: 'Emoji',
  applies (ctx) {
    if (!ctx.state.field(configField).autocompleteSuggestEmojis) {
      return false
    }
    if (ctx.state.doc.sliceString(ctx.pos - 1, ctx.pos) !== ':') {
      return false
    }
    const line = ctx.state.doc.lineAt(ctx.pos)
    if (ctx.pos - line.from === 1) {
      return ctx.pos
    }
    return ctx.state.doc.sliceString(ctx.pos - 2, ctx.pos - 1) === ' ' ? ctx.pos : false
  },
  entries (_ctx, query) {
    const lowered = query.toLowerCase()
    return entries.filter(entry => {
      const detail = entry.detail?.toLowerCase() ?? ''
      const info = typeof entry.info === 'string' ? entry.info.toLowerCase() : ''
      return detail.includes(lowered) || info.includes(lowered)
    })
  }
}

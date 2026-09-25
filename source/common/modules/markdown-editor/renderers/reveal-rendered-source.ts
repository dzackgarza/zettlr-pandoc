/**
 * Shared edit-first activation for rendered Markdown surfaces.
 *
 * The invariant is that the intended document position/range is resolved while
 * the rendered DOM still exists. The pointer event is then consumed before the
 * selection update changes decorations and therefore changes layout.
 */

import type { EditorView } from '@codemirror/view'

function consumePointerEvent (event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

export function selectRenderedSourceRange (
  view: EditorView,
  event: MouseEvent,
  from: number,
  to: number
): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > view.state.doc.length) {
    return false
  }

  consumePointerEvent(event)
  view.focus()
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
  return true
}

export function placeCursorFromRenderedPoint (
  view: EditorView,
  event: MouseEvent,
  from: number,
  to: number
): boolean {
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (position === null) {
    return false
  }

  const anchor = Math.min(Math.max(position, from), to)
  consumePointerEvent(event)
  view.focus()
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
  return true
}

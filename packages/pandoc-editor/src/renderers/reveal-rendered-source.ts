/**
 * Shared edit-first activation for rendered Markdown surfaces.
 *
 * The invariant is that the intended document position/range is resolved while
 * the rendered DOM still exists. The pointer event is then consumed before the
 * selection update changes decorations and therefore changes layout.
 *
 * A Shift-click extends the selection, as it does in text: the anchor stays,
 * and the head goes to the clicked source (#181).
 */

import type { EditorView } from "@codemirror/view";

function consumePointerEvent(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function selectRenderedSourceRange(
  view: EditorView,
  event: MouseEvent,
  from: number,
  to: number,
): boolean {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > view.state.doc.length
  ) {
    return false;
  }

  consumePointerEvent(event);
  view.focus();
  view.dispatch({ selection: extendedOr(view, event, from, to), scrollIntoView: true });
  return true;
}

export function placeCursorFromRenderedPoint(
  view: EditorView,
  event: MouseEvent,
  from: number,
  to: number,
): boolean {
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) {
    return false;
  }

  const caret = Math.min(Math.max(position, from), to);
  consumePointerEvent(event);
  view.focus();
  view.dispatch({ selection: extendedOr(view, event, caret, caret), scrollIntoView: true });
  return true;
}

/**
 * The selection of a click on the source `from`–`to`. A Shift-click keeps the
 * anchor and covers the whole source: the head goes to the end of the source
 * that is farther from the anchor.
 */
function extendedOr(
  view: EditorView,
  event: MouseEvent,
  from: number,
  to: number,
): { anchor: number; head: number } {
  if (!event.shiftKey) {
    return { anchor: from, head: to };
  }
  const { anchor } = view.state.selection.main;
  return { anchor, head: anchor >= to ? from : to };
}

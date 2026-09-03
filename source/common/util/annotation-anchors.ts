/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        mapAnnotationThroughChanges
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Carries one annotation's anchor across an edit to the
 *                  document it points into.
 *
 *                  An annotation and a review suggestion want opposite things
 *                  from the same edit, which is why this is not
 *                  review-suggestion-anchors.ts. A suggestion is the agent's
 *                  text, so owner text typed into it splits it and stays
 *                  outside. An annotation is a comment ABOUT a stretch, so
 *                  owner text typed into that stretch is part of what the
 *                  comment is about, and the range simply grows. One
 *                  contiguous range, and no enumeration of the individual
 *                  edits: the two positions carry the whole answer.
 *
 *                  Association carries the boundary rule. The start sticks to
 *                  the text after it and the end to the text before it, so an
 *                  insertion at either edge lands outside the target while an
 *                  insertion anywhere between them lands inside.
 *
 *                  The two mapped positions then bracket whatever is left of
 *                  the target, and that is the whole answer. An owner who
 *                  rewrites exactly the annotated stretch still has both
 *                  boundaries, so the annotation covers the rewrite — the
 *                  same reading of a rewrite that review-suggestion-anchors.ts
 *                  takes. When the positions meet instead, nothing the
 *                  comment was made about is bracketed any more, and the
 *                  anchor collapses to the seam and keeps its quoted text.
 *                  Putting it back on a stretch of text is the owner's
 *                  Reattach, never this function's inference.
 *
 * END HEADER
 */

import type { ChangeDesc } from "@codemirror/state";
import type { AnnotationAnchor } from "@dts/common/annotation-domain";

export interface MappedAnnotationAnchor {
  anchor: AnnotationAnchor;
  changed: boolean;
}

export function mapAnnotationThroughChanges(
  anchor: AnnotationAnchor,
  changes: ChangeDesc,
): MappedAnnotationAnchor {
  if (anchor.state === "orphaned") {
    return { anchor, changed: false };
  }

  if (anchor.state === "point") {
    const at = changes.mapPos(anchor.at, -1);
    return at === anchor.at
      ? { anchor, changed: false }
      : { anchor: { ...anchor, at }, changed: true };
  }

  const from = changes.mapPos(anchor.from, 1);
  const to = changes.mapPos(anchor.to, -1);

  if (from >= to) {
    return {
      anchor: {
        state: "point",
        at: changes.mapPos(anchor.from, -1),
        quotedText: anchor.quotedText,
        reason: "target-deleted",
      },
      changed: true,
    };
  }

  return from === anchor.from && to === anchor.to
    ? { anchor, changed: false }
    : { anchor: { ...anchor, from, to }, changed: true };
}

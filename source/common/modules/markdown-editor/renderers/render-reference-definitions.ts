/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceDefinitionBadgeRenderer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Decorates every reference definition in the current
 *                  document with a subtle label badge and an always-visible
 *                  citing-count badge (issue #1 Phase 4).
 *
 *                  CONTRACT (locked by test/editor-reference-badges.spec.ts):
 *
 *                  - The definition set is exactly
 *                    workspaceReferencesField.snapshot.definitions (the
 *                    current document's live snapshot); while the field is
 *                    null nothing renders and no counts are fabricated.
 *                  - Every definition receives one subtle label badge
 *                    (span.reference-definition-badge with
 *                    data-reference-key) whose text is the authored key, and
 *                    one separate always-visible count badge
 *                    (span.reference-count-badge with data-reference-key and
 *                    data-citing-count), INCLUDING when the count is zero.
 *                  - The citing count of a definition is the number of
 *                    entries in workspaceOccurrences whose key equals the
 *                    definition's key — occurrences across the whole merged
 *                    workspace view, not just this document. The badge text
 *                    is `1 reference` for exactly one citing location and
 *                    `N references` otherwise (including `0 references`).
 *                  - Badges present themselves beside the authored source:
 *                    they never replace, hide, or renumber authored text,
 *                    and they never display any computed reference number.
 *                  - Clicking a count badge emits the same signal family as
 *                    Mod-P: it dispatches
 *                    openReferenceSearchEffect.of({ key }) so the shared
 *                    overlay opens populated with that definition's workspace
 *                    citing locations. The assertion target is that emitted
 *                    intent (and the badge's own count), never overlay
 *                    internals.
 *
 *                  IMPLEMENTATION NOTE: the badge DOM is owned by a
 *                  ViewPlugin that synchronizes one badge group per
 *                  definition into its own overlay container (the panel and
 *                  gutter archetype). Inline widget decorations cannot
 *                  satisfy the contract because CodeMirror only materializes
 *                  viewport lines, while the count badges of EVERY
 *                  definition must be present and clickable. Geometry is
 *                  applied in the measure cycle; badge groups whose
 *                  definition line has no layout yet stay unpositioned.
 *
 *                  PLACE: a renderer that draws the line of a definition
 *                  itself (the header of a fenced div) puts a
 *                  referenceBadgeAnchor in its DOM. The layer gives that
 *                  anchor the size of the badge group and puts the group on
 *                  it, so the badges have room in the flow of the header and
 *                  wrap with it. A definition without an anchor has its
 *                  badges after the end of its line; they stay inside the
 *                  layer, so they add no horizontal scroll.
 *
 * END HEADER
 */

import { type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type SourceRange } from "@dts/common/references";
import { openReferenceSearchEffect } from "../plugins/reference-search-effect";
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
} from "../plugins/workspace-references-field";

/**
 * One synchronized badge group: the definition it decorates (with its live
 * range) and the group's DOM (label badge plus count badge).
 */
interface BadgeGroup {
  key: string;
  citingCount: number;
  range: SourceRange;
  dom: HTMLElement;
}

/** The size of a badge group, with the space before it. */
interface BadgeRoom {
  width: number;
  height: number;
}

/**
 * The measured place of one badge group; null when its line has no layout.
 * `anchor` is the anchor that gives the group its room, when a renderer drew
 * one for the line of the definition.
 */
interface BadgePlacement {
  group: BadgeGroup;
  position: { left: number; top: number } | null;
  anchor?: { element: HTMLElement; room: BadgeRoom };
}

/** The space between the end of a line and its badge group, in pixels. */
const BADGE_GAP = 8;

const ANCHOR_CLASS = "reference-badge-anchor";

// The editor of each anchor: a widget learns of its removal with its DOM
// only.
const anchorViews = new WeakMap<Element, EditorView>();

/**
 * The room of the badges of one definition in the DOM of a renderer that
 * draws the line of that definition itself. The badge layer gives the
 * element the size of the badge group of the definition on that line and
 * puts the group on it.
 */
export function referenceBadgeAnchor(view: EditorView): HTMLElement {
  const anchor = document.createElement("span");
  anchor.classList.add(ANCHOR_CLASS);
  anchor.setAttribute("aria-hidden", "true");
  anchorViews.set(anchor, view);
  view.plugin(badgePlugin)?.requestPlacement();
  return anchor;
}

/**
 * Tells the badge layer that the editor removed the DOM of a renderer, so
 * the badges that were on an anchor in it get the place of their line.
 */
export function referenceBadgeAnchorsRemoved(dom: HTMLElement): void {
  for (const anchor of dom.querySelectorAll(`.${ANCHOR_CLASS}`)) {
    anchorViews.get(anchor)?.plugin(badgePlugin)?.requestPlacement();
  }
}

/**
 * Builds the DOM of one badge group: the subtle label badge showing the
 * authored key and the always-visible, clickable citing-count badge.
 */
function buildBadgeGroup(view: EditorView, key: string, citingCount: number): HTMLElement {
  const group = document.createElement("span");
  group.classList.add("reference-badge-group");

  const label = document.createElement("span");
  label.classList.add("reference-definition-badge");
  label.dataset.referenceKey = key;
  label.textContent = key;
  group.appendChild(label);

  const count = document.createElement("span");
  count.classList.add("reference-count-badge");
  count.dataset.referenceKey = key;
  count.dataset.citingCount = String(citingCount);
  count.textContent = citingCount === 1 ? "1 reference" : `${citingCount} references`;
  count.addEventListener("click", () => {
    // The same signal family as Mod-P, keyed to this definition: App.vue
    // opens the shared overlay over the provider's freshly fetched merged
    // snapshot — the single owner of the citing-locations fact (issue #46).
    view.dispatch({
      effects: openReferenceSearchEffect.of({ key }),
    });
  });
  group.appendChild(count);

  return group;
}

class ReferenceDefinitionBadges {
  private readonly container: HTMLElement;
  private groups: BadgeGroup[];
  private readonly measureReq: {
    read: () => BadgePlacement[];
    write: (placements: BadgePlacement[]) => void;
  };

  constructor(private readonly view: EditorView) {
    this.container = document.createElement("div");
    this.container.classList.add("reference-definition-badge-layer");
    this.container.setAttribute("aria-hidden", "true");
    view.scrollDOM.appendChild(this.container);
    this.groups = [];
    this.measureReq = {
      read: () => this.measurePositions(),
      write: (placements) => this.applyPositions(placements),
    };
    this.sync(view.state);
    view.requestMeasure(this.measureReq);
  }

  update(update: ViewUpdate): void {
    const hasPayload = update.transactions.some((transaction) => {
      return transaction.effects.some((effect) => effect.is(workspaceReferencesUpdate));
    });

    if (hasPayload) {
      this.sync(update.state);
      update.view.requestMeasure(this.measureReq);
      return;
    }

    if (update.docChanged) {
      // The snapshot ranges are stale relative to the new buffer until the
      // next payload arrives: keep the badges anchored by mapping.
      for (const group of this.groups) {
        group.range = {
          from: update.changes.mapPos(group.range.from),
          to: update.changes.mapPos(group.range.to),
        };
      }
    }

    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      update.view.requestMeasure(this.measureReq);
    }
  }

  destroy(): void {
    this.container.remove();
  }

  /** Measures the places of the badge groups again in the next measure cycle. */
  requestPlacement(): void {
    this.view.requestMeasure(this.measureReq);
  }

  /**
   * Rebuilds the badge DOM from the current workspace view: one badge group
   * per definition, in document order. While the field is null nothing
   * renders and no counts are fabricated.
   */
  private sync(state: EditorState): void {
    // A table cell subview carries no workspace reference field.
    const references = state.field(workspaceReferencesField, false);
    this.container.replaceChildren();
    this.groups = [];

    if (references === undefined || references === null) {
      return;
    }

    // Every definition starts with no citing occurrence; an occurrence of a
    // key that this document does not define gets no badge.
    const citingCounts = new Map<string, number>();
    for (const definition of references.snapshot.definitions) {
      citingCounts.set(definition.key, 0);
    }
    for (const occurrence of references.workspaceOccurrences) {
      const count = citingCounts.get(occurrence.key);
      if (count !== undefined) {
        citingCounts.set(occurrence.key, count + 1);
      }
    }

    for (const definition of references.snapshot.definitions) {
      const citingCount = citingCounts.get(definition.key);
      if (citingCount === undefined) {
        throw new Error(`Reference definition ${definition.key} has no citing count.`);
      }
      const dom = buildBadgeGroup(this.view, definition.key, citingCount);
      this.container.appendChild(dom);
      this.groups.push({ key: definition.key, citingCount, range: { ...definition.range }, dom });
    }
  }

  /**
   * Measure phase: the badge group of a definition hangs at the end of the
   * line bearing the authored id token. Lines without layout (outside the
   * viewport) yield null.
   */
  private measurePositions(): BadgePlacement[] {
    const base = this.container.getBoundingClientRect();
    const { doc } = this.view.state;
    const { from, to } = this.view.viewport;

    // The anchors that renderers drew, by the start of the line they are on.
    const anchors = new Map<number, HTMLElement>();
    for (const anchor of this.view.contentDOM.querySelectorAll<HTMLElement>(`.${ANCHOR_CLASS}`)) {
      anchors.set(doc.lineAt(this.view.posAtDOM(anchor)).from, anchor);
    }

    return this.groups.map((group) => {
      if (group.range.to < from || group.range.to > to) {
        return { group, position: null };
      }

      const line = doc.lineAt(group.range.to);
      const size = group.dom.getBoundingClientRect();
      const anchor = anchors.get(line.from);
      if (anchor !== undefined) {
        const place = anchor.getBoundingClientRect();
        // An anchor that wrapped to the start of a row has no text before
        // it, so its group starts at the edge of the row.
        const row = anchor.parentElement?.getBoundingClientRect().left ?? place.left;
        const gap = place.left - row < 1 ? 0 : BADGE_GAP;
        return {
          group,
          position: { left: place.left - base.left + gap, top: place.top - base.top },
          anchor: {
            element: anchor,
            room: { width: Math.ceil(size.width) + BADGE_GAP, height: Math.ceil(size.height) },
          },
        };
      }

      const coords = this.view.coordsAtPos(line.to, -1);
      if (coords === null) {
        return { group, position: null };
      }

      // The group stays inside the layer: a group past the right edge would
      // make the editor scroll horizontally.
      const left = Math.min(coords.right - base.left + BADGE_GAP, base.width - size.width);
      return { group, position: { left: Math.max(0, left), top: coords.top - base.top } };
    });
  }

  /**
   * Write phase: gives each anchor the room of its badge group, positions
   * every badge group, and hides the groups whose line has no layout. A
   * change of an anchor moves the text around it, so the places are measured
   * again after it.
   */
  private applyPositions(placements: BadgePlacement[]): void {
    let anchorChanged = false;
    for (const { group, position, anchor } of placements) {
      if (position === null) {
        // A group that is not shown is still laid out: it goes back to the
        // corner of the layer, where it adds no scroll width.
        group.dom.classList.remove("positioned");
        group.dom.style.removeProperty("left");
        group.dom.style.removeProperty("top");
        continue;
      }

      if (anchor !== undefined) {
        const width = `${anchor.room.width}px`;
        const height = `${anchor.room.height}px`;
        if (anchor.element.style.width !== width || anchor.element.style.height !== height) {
          anchor.element.style.width = width;
          anchor.element.style.height = height;
          anchorChanged = true;
        }
      }

      group.dom.classList.add("positioned");
      group.dom.style.left = `${position.left}px`;
      group.dom.style.top = `${position.top}px`;
    }

    if (anchorChanged) {
      this.view.requestMeasure(this.measureReq);
    }
  }
}

const badgePlugin = ViewPlugin.fromClass(ReferenceDefinitionBadges);

/**
 * Base styling for the badges: the label badge is subtle, the count badge is
 * always visible and clickable, and neither ever displays a computed number
 * for the reference itself.
 */
const badgeTheme = EditorView.baseTheme({
  ".reference-definition-badge-layer": {
    position: "absolute",
    inset: "0",
    zIndex: "2",
    pointerEvents: "none",
  },
  // A group without a place is laid out and not shown: the layer reads the
  // size of each group before it gives the group its place.
  ".reference-badge-group": {
    position: "absolute",
    left: "0",
    top: "0",
    display: "inline-flex",
    gap: "0.35em",
    visibility: "hidden",
    whiteSpace: "nowrap",
  },
  ".reference-badge-group.positioned": {
    visibility: "visible",
  },
  [`.${ANCHOR_CLASS}`]: {
    display: "inline-block",
    verticalAlign: "middle",
  },
  ".reference-definition-badge, .reference-count-badge": {
    display: "inline-block",
    padding: "0 0.35em",
    borderRadius: "3px",
    fontSize: "75%",
  },
  ".reference-count-badge": {
    cursor: "pointer",
    pointerEvents: "auto",
  },
  "&light .reference-definition-badge": {
    backgroundColor: "rgba(120, 120, 120, 0.08)",
    border: "1px solid rgba(120, 120, 120, 0.22)",
    color: "#777777",
  },
  "&dark .reference-definition-badge": {
    backgroundColor: "rgba(200, 200, 200, 0.1)",
    border: "1px solid rgba(200, 200, 200, 0.22)",
    color: "#999999",
  },
  "&light .reference-count-badge": {
    backgroundColor: "rgba(28, 120, 176, 0.1)",
    border: "1px solid rgba(28, 120, 176, 0.3)",
    color: "#1c5f8a",
  },
  "&dark .reference-count-badge": {
    backgroundColor: "rgba(93, 173, 226, 0.15)",
    border: "1px solid rgba(93, 173, 226, 0.35)",
    color: "#9ecbe8",
  },
});

export const renderReferenceDefinitions = [badgePlugin, badgeTheme];

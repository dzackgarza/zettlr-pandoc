/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        collaborationControls
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Places the owner's review and annotation controls inside
 *                  the document, where the change or the comment is:
 *
 *                  - one block under every outstanding review chunk, for
 *                    Accept, Reject and the chunk's note;
 *                  - one review bar at the bottom of the editor, for the
 *                    actions that name no chunk (Accept all, Reject
 *                    remaining, the review comment);
 *                  - the thread of the active annotation, in a block under
 *                    the last line its target covers.
 *
 *                  This follows @codemirror/merge's unified view
 *                  (src/unified.ts, `mergeControls`), which puts a block
 *                  widget carrying Accept/Reject at each chunk, and the
 *                  inline hunk toolbar and floating Accept all bar of editor
 *                  review UIs (VS Code chat editing, the VS Code comment
 *                  widget for threads). The chunks and the thread come from
 *                  the document authority's broadcast (review-chunks.ts,
 *                  text-annotations.ts), not from a diff against an
 *                  original buffer, so only the widget placement is reused,
 *                  not merge's chunk state.
 *
 *                  The extension places and removes the blocks; what goes
 *                  inside them is the host's (`MountCollaborationControl`),
 *                  in the same way `mergeControls` lets its caller build
 *                  the buttons. A chunk block and the review bar are inert
 *                  while the review chunks are out of step with the
 *                  provider, since every review action is fenced on the
 *                  provider's working text.
 *
 * END HEADER
 */

import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type Panel,
  showPanel,
  WidgetType,
} from "@codemirror/view";
import type { ReviewSuggestionView } from "@dts/common/review-diff";
import {
  getReviewChunksState,
  type ReviewChunksFieldValue,
  suggestionLastLineEnd,
} from "./review-chunks";
import {
  activeAnnotationThreadAnchor,
  getTextAnnotationsState,
  type TextAnnotationsState,
} from "./text-annotations";

/** One block the editor places for the host to fill. */
export type CollaborationControl =
  | { kind: "review-chunk"; chunkId: string }
  | { kind: "review-bar" }
  | { kind: "annotation-thread"; annotationId: string };

/**
 * Fills a placed block with its content and returns the function that
 * removes that content again when the editor drops the block.
 */
export type MountCollaborationControl = (
  dom: HTMLElement,
  control: CollaborationControl,
) => () => void;

const mountFacet = Facet.define<MountCollaborationControl>();

function requireMount(state: EditorState): MountCollaborationControl {
  const mounts = state.facet(mountFacet);
  if (mounts.length !== 1) {
    throw new Error(`collaboration controls require exactly one host, received ${mounts.length}`);
  }
  return mounts[0];
}

function controlKey(control: CollaborationControl): string {
  switch (control.kind) {
    case "review-chunk":
      return `review-chunk:${control.chunkId}`;
    case "review-bar":
      return "review-bar";
    case "annotation-thread":
      return `annotation-thread:${control.annotationId}`;
  }
}

interface MountedBlock {
  key: string;
  unmount: () => void;
  resizeObserver: ResizeObserver;
}

const mountedBlocks = new WeakMap<HTMLElement, MountedBlock>();

/** An inert block takes no pointer or keyboard input: its actions would be
 *  fenced on a working text the provider has not confirmed. */
function applyInteractive(dom: HTMLElement, interactive: boolean): void {
  dom.toggleAttribute("inert", !interactive);
  dom.classList.toggle("cm-collaborationControl-syncing", !interactive);
}

/** Whether the chunk blocks of a state take input. */
function chunksInteractive(state: EditorState): boolean {
  return getReviewChunksState(state)?.synced === true;
}

/**
 * One block. Its widget compares by the control alone, so a block stays in
 * the DOM while the review changes around it; the interactivity of a chunk
 * block follows the review through `syncChunkBlocks`.
 */
class ControlBlockWidget extends WidgetType {
  constructor(readonly control: CollaborationControl) {
    super();
  }

  eq(other: ControlBlockWidget): boolean {
    return controlKey(other.control) === controlKey(this.control);
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = `cm-collaborationControl cm-collaborationControl-${this.control.kind}`;
    applyInteractive(dom, this.control.kind !== "review-chunk" || chunksInteractive(view.state));
    const unmount = requireMount(view.state)(dom, this.control);
    // The host renders into the block after CodeMirror measured it, and a
    // thread grows with every reply: re-measure so the height map follows.
    const resizeObserver = new ResizeObserver(() => {
      view.requestMeasure();
    });
    resizeObserver.observe(dom);
    mountedBlocks.set(dom, { key: controlKey(this.control), unmount, resizeObserver });
    return dom;
  }

  destroy(dom: HTMLElement): void {
    const mounted = mountedBlocks.get(dom);
    if (mounted === undefined) {
      return;
    }
    mounted.resizeObserver.disconnect();
    mounted.unmount();
    mountedBlocks.delete(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Locks or unlocks each chunk block in the DOM when the sync state of the
 * review changes. The host's content stays, so a half-typed note survives.
 */
const syncChunkBlocks = EditorView.updateListener.of((update) => {
  const interactive = chunksInteractive(update.state);
  if (chunksInteractive(update.startState) === interactive) {
    return;
  }
  for (const dom of update.view.contentDOM.querySelectorAll<HTMLElement>(
    ".cm-collaborationControl-review-chunk",
  )) {
    applyInteractive(dom, interactive);
  }
});

/** The suggestion id of each chunk block decoration. */
const chunkBlockIds = new WeakMap<Decoration, string>();

function chunkBlock(state: EditorState, suggestion: ReviewSuggestionView): Range<Decoration> {
  const decoration = Decoration.widget({
    widget: new ControlBlockWidget({ kind: "review-chunk", chunkId: suggestion.suggestionId }),
    block: true,
    side: 1,
  });
  chunkBlockIds.set(decoration, suggestion.suggestionId);
  return decoration.range(suggestionLastLineEnd(state, suggestion));
}

interface ControlsFieldValue {
  review: ReviewChunksFieldValue | undefined;
  annotations: TextAnnotationsState | undefined;
  chunkBlocks: DecorationSet;
  thread: DecorationSet;
}

function allChunkBlocks(
  state: EditorState,
  review: ReviewChunksFieldValue | undefined,
): DecorationSet {
  if (review === undefined) {
    return Decoration.none;
  }
  return Decoration.set(
    review.suggestions().map((suggestion) => chunkBlock(state, suggestion)),
    true,
  );
}

/**
 * The chunk blocks after a transaction. When the review field states what
 * the transaction changed (`baseId`), only the blocks of those chunks are
 * made again; each other block moves with the text.
 */
function nextChunkBlocks(
  value: ControlsFieldValue,
  review: ReviewChunksFieldValue | undefined,
  transaction: Transaction,
): DecorationSet {
  const before = value.review;
  if (review === undefined || before === undefined) {
    return allChunkBlocks(transaction.state, review);
  }
  if (review === before) {
    return value.chunkBlocks.map(transaction.changes);
  }
  if (review.baseId !== before.id) {
    return allChunkBlocks(transaction.state, review);
  }
  let blocks = value.chunkBlocks.map(transaction.changes);
  for (const removed of review.delta.removed) {
    blocks = blocks.update({
      filterFrom: removed.from,
      filterTo: removed.to,
      filter: (_from, _to, decoration) => chunkBlockIds.get(decoration) !== removed.suggestionId,
    });
  }
  return blocks.update({
    add: review.delta.added.map((suggestion) => chunkBlock(transaction.state, suggestion)),
    sort: true,
  });
}

function threadBlock(
  state: EditorState,
  annotations: TextAnnotationsState | undefined,
): DecorationSet {
  const thread =
    annotations === undefined ? undefined : activeAnnotationThreadAnchor(annotations, state.doc);
  if (thread === undefined) {
    return Decoration.none;
  }
  return Decoration.set(
    Decoration.widget({
      widget: new ControlBlockWidget({
        kind: "annotation-thread",
        annotationId: thread.annotationId,
      }),
      block: true,
      side: 2,
    }).range(thread.position),
  );
}

const controlsField = StateField.define<ControlsFieldValue>({
  create(state) {
    const review = getReviewChunksState(state);
    const annotations = getTextAnnotationsState(state);
    return {
      review,
      annotations,
      chunkBlocks: allChunkBlocks(state, review),
      thread: threadBlock(state, annotations),
    };
  },
  update(value, transaction) {
    const review = getReviewChunksState(transaction.state);
    const annotations = getTextAnnotationsState(transaction.state);
    if (!transaction.docChanged && review === value.review && annotations === value.annotations) {
      return value;
    }
    return {
      review,
      annotations,
      chunkBlocks: nextChunkBlocks(value, review, transaction),
      thread:
        transaction.docChanged || annotations !== value.annotations
          ? threadBlock(transaction.state, annotations)
          : value.thread,
    };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.chunkBlocks),
    EditorView.decorations.from(field, (value) => value.thread),
    showPanel.from(field, (value) =>
      value.review !== undefined && value.review.count > 0 ? reviewBarPanel : null,
    ),
  ],
});

/**
 * The review bar. A module-level constructor keeps one panel alive across
 * every broadcast; only its interactivity follows the review's sync state.
 */
function reviewBarPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-collaborationControl cm-collaborationControl-review-bar";
  let unmount: (() => void) | undefined;
  const sync = (state: EditorState): void => {
    applyInteractive(dom, getReviewChunksState(state)?.synced === true);
  };
  sync(view.state);
  return {
    dom,
    top: false,
    mount() {
      unmount = requireMount(view.state)(dom, { kind: "review-bar" });
    },
    update(update) {
      sync(update.state);
    },
    destroy() {
      unmount?.();
    },
  };
}

export function collaborationControls(mount: MountCollaborationControl): Extension {
  return [mountFacet.of(mount), controlsField, syncChunkBlocks, collaborationControlsTheme];
}

const collaborationControlsTheme = EditorView.baseTheme({
  ".cm-collaborationControl": {
    fontFamily: "system-ui, sans-serif",
    whiteSpace: "normal",
    cursor: "auto",
  },
  ".cm-collaborationControl-review-chunk, .cm-collaborationControl-annotation-thread": {
    padding: "4px 0 8px",
  },
  ".cm-collaborationControl-syncing": {
    opacity: "0.55",
  },
});

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

import { Facet, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type Panel,
  showPanel,
  WidgetType
} from '@codemirror/view'
import { getReviewChunksState, suggestionLastLineEnd, type ReviewChunksFieldValue } from './review-chunks'
import { activeAnnotationThreadAnchor, getTextAnnotationsState, type TextAnnotationsState } from './text-annotations'

/** One block the editor places for the host to fill. */
export type CollaborationControl =
  | { kind: 'review-chunk', chunkId: string }
  | { kind: 'review-bar' }
  | { kind: 'annotation-thread', annotationId: string }

/**
 * Fills a placed block with its content and returns the function that
 * removes that content again when the editor drops the block.
 */
export type MountCollaborationControl = (dom: HTMLElement, control: CollaborationControl) => () => void

const mountFacet = Facet.define<MountCollaborationControl>()

function requireMount (state: EditorState): MountCollaborationControl {
  const mounts = state.facet(mountFacet)
  if (mounts.length !== 1) {
    throw new Error(`collaboration controls require exactly one host, received ${mounts.length}`)
  }
  return mounts[0]
}

function controlKey (control: CollaborationControl): string {
  switch (control.kind) {
    case 'review-chunk':
      return `review-chunk:${control.chunkId}`
    case 'review-bar':
      return 'review-bar'
    case 'annotation-thread':
      return `annotation-thread:${control.annotationId}`
  }
}

interface MountedBlock {
  key: string
  unmount: () => void
  resizeObserver: ResizeObserver
}

const mountedBlocks = new WeakMap<HTMLElement, MountedBlock>()

/** An inert block takes no pointer or keyboard input: its actions would be
 *  fenced on a working text the provider has not confirmed. */
function applyInteractive (dom: HTMLElement, interactive: boolean): void {
  dom.toggleAttribute('inert', !interactive)
  dom.classList.toggle('cm-collaborationControl-syncing', !interactive)
}

class ControlBlockWidget extends WidgetType {
  constructor (
    readonly control: CollaborationControl,
    readonly interactive: boolean
  ) {
    super()
  }

  eq (other: ControlBlockWidget): boolean {
    return controlKey(other.control) === controlKey(this.control) && other.interactive === this.interactive
  }

  toDOM (view: EditorView): HTMLElement {
    const dom = document.createElement('div')
    dom.className = `cm-collaborationControl cm-collaborationControl-${this.control.kind}`
    applyInteractive(dom, this.interactive)
    const unmount = requireMount(view.state)(dom, this.control)
    // The host renders into the block after CodeMirror measured it, and a
    // thread grows with every reply: re-measure so the height map follows.
    const resizeObserver = new ResizeObserver(() => { view.requestMeasure() })
    resizeObserver.observe(dom)
    mountedBlocks.set(dom, { key: controlKey(this.control), unmount, resizeObserver })
    return dom
  }

  /** Same block, new interactivity: keep the host's content (a half-typed
   *  note survives), only lock or unlock it. */
  updateDOM (dom: HTMLElement): boolean {
    if (mountedBlocks.get(dom)?.key !== controlKey(this.control)) {
      return false
    }
    applyInteractive(dom, this.interactive)
    return true
  }

  destroy (dom: HTMLElement): void {
    const mounted = mountedBlocks.get(dom)
    if (mounted === undefined) {
      return
    }
    mounted.resizeObserver.disconnect()
    mounted.unmount()
    mountedBlocks.delete(dom)
  }

  ignoreEvent (): boolean {
    return true
  }
}

interface ControlsFieldValue {
  review: ReviewChunksFieldValue | undefined
  annotations: TextAnnotationsState | undefined
  decorations: DecorationSet
}

function buildControls (state: EditorState): ControlsFieldValue {
  const review = getReviewChunksState(state)
  const annotations = getTextAnnotationsState(state)
  const blocks: Array<Range<Decoration>> = []

  if (review !== undefined) {
    for (const suggestion of review.suggestions) {
      blocks.push(Decoration.widget({
        widget: new ControlBlockWidget({ kind: 'review-chunk', chunkId: suggestion.suggestionId }, review.synced),
        block: true,
        side: 1
      }).range(suggestionLastLineEnd(state, suggestion)))
    }
  }

  const thread = annotations === undefined ? undefined : activeAnnotationThreadAnchor(annotations, state.doc)
  if (thread !== undefined) {
    blocks.push(Decoration.widget({
      widget: new ControlBlockWidget({ kind: 'annotation-thread', annotationId: thread.annotationId }, true),
      block: true,
      side: 2
    }).range(thread.position))
  }

  return { review, annotations, decorations: Decoration.set(blocks, true) }
}

const controlsField = StateField.define<ControlsFieldValue>({
  create: buildControls,
  update (value, tr) {
    if (
      !tr.docChanged &&
      getReviewChunksState(tr.state) === value.review &&
      getTextAnnotationsState(tr.state) === value.annotations
    ) {
      return value
    }
    return buildControls(tr.state)
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.decorations),
    showPanel.from(field, value => value.review !== undefined && value.review.suggestions.length > 0 ? reviewBarPanel : null)
  ]
})

/**
 * The review bar. A module-level constructor keeps one panel alive across
 * every broadcast; only its interactivity follows the review's sync state.
 */
function reviewBarPanel (view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-collaborationControl cm-collaborationControl-review-bar'
  let unmount: (() => void) | undefined
  const sync = (state: EditorState): void => {
    applyInteractive(dom, getReviewChunksState(state)?.synced === true)
  }
  sync(view.state)
  return {
    dom,
    top: false,
    mount () {
      unmount = requireMount(view.state)(dom, { kind: 'review-bar' })
    },
    update (update) {
      sync(update.state)
    },
    destroy () {
      unmount?.()
    }
  }
}

export function collaborationControls (mount: MountCollaborationControl): Extension {
  return [mountFacet.of(mount), controlsField, collaborationControlsTheme]
}

const collaborationControlsTheme = EditorView.baseTheme({
  '.cm-collaborationControl': {
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'normal',
    cursor: 'auto'
  },
  '.cm-collaborationControl-review-chunk, .cm-collaborationControl-annotation-thread': {
    padding: '4px 0 8px'
  },
  '.cm-collaborationControl-syncing': {
    opacity: '0.55'
  }
})

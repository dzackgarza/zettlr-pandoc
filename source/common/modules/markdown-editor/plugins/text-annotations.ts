/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        textAnnotationsExtension
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Renders the editor's half of a text annotation: a
 *                  highlight over the target span and an ordinal marker on
 *                  the target's first line. Nothing else — no message text,
 *                  no thread, no button, no proposal state (invariant I4).
 *                  Everything the owner reads or clicks lives in the
 *                  annotations panel; this field only distinguishes the
 *                  seven editor states plan section 3 requires and reports
 *                  no interaction of its own. Selection, drafting, and the
 *                  resolved-visibility toggle are driven by effects a host
 *                  (the panel, the creation composer) dispatches.
 *
 *                  The ordinal marker rides the built-in line-number gutter
 *                  via CodeMirror's `lineNumberMarkers` facet (Decision Log:
 *                  "markers ride the left line-number gutter, per mockup
 *                  3"). That facet's own line-number rendering is suppressed
 *                  for a line once any marker on it defines `toDOM`, so this
 *                  marker renders the line's digits itself alongside the
 *                  ordinal badge — an annotated line must not lose its
 *                  number.
 *
 *                  An orphaned anchor carries no document position (its
 *                  target already drifted out from under it), so it has
 *                  nothing to anchor a marker to; it renders at the
 *                  document's first line, the one deterministic location
 *                  every document has.
 *
 * END HEADER
 */

import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, GutterMarker, lineNumberMarkers } from '@codemirror/view'
import { mapAnnotationThroughChanges } from '@common/util/annotation-anchors'
import type { AnnotationSet, TextAnnotation } from '@dts/common/annotation-domain'

/** Replaces the whole visible annotation set (a fresh broadcast). */
export const setAnnotationSessionEffect = StateEffect.define<AnnotationSet>()

/** Marks one annotation "active" (or none), for the stronger treatment S4 pairs with a selected card. */
export const setActiveAnnotationEffect = StateEffect.define<string | null>()

/** Shows a transient treatment on the range the creation composer is drafting over. */
export const setAnnotationDraftEffect = StateEffect.define<{ from: number, to: number }>()

/** Clears the draft treatment — the composer saved or was cancelled. */
export const clearAnnotationDraftEffect = StateEffect.define<null>()

/** Toggles whether resolved annotations render at all ("View resolved (N)"). */
export const showResolvedAnnotationsEffect = StateEffect.define<boolean>()

export interface TextAnnotationsState {
  annotations: TextAnnotation[]
  activeAnnotationId: string | null
  draftRange: { from: number, to: number } | null
  showResolved: boolean
}

interface TextAnnotationsFieldValue extends TextAnnotationsState {
  decorations: DecorationSet
  gutterMarkers: RangeSet<GutterMarker>
}

type MarkerKind = 'range' | 'point' | 'orphaned' | 'overlapping'

/**
 * One gutter row: the line's own digits plus an ordinal (or count) badge.
 * `eq` is what lets CodeMirror leave an unchanged row's DOM alone across a
 * broadcast that touched a different line.
 */
class AnnotationGutterMarker extends GutterMarker {
  constructor (
    private readonly lineNumberLabel: string,
    private readonly kind: MarkerKind,
    private readonly count: number,
    private readonly ordinals: readonly number[],
    private readonly active: boolean,
    private readonly resolved: boolean
  ) {
    super()
  }

  eq (other: AnnotationGutterMarker): boolean {
    return other.lineNumberLabel === this.lineNumberLabel &&
      other.kind === this.kind &&
      other.count === this.count &&
      other.active === this.active &&
      other.resolved === this.resolved &&
      other.ordinals.length === this.ordinals.length &&
      other.ordinals.every((ordinal, index) => ordinal === this.ordinals[index])
  }

  toDOM (): HTMLElement {
    const wrapper = document.createElement('span')
    wrapper.className = [
      'cm-textAnnotation-gutterMarker',
      `cm-textAnnotation-gutterMarker-${this.kind}`,
      this.active ? 'cm-textAnnotation-gutterMarker-active' : '',
      this.resolved ? 'cm-textAnnotation-gutterMarker-resolved' : ''
    ].filter(part => part !== '').join(' ')

    // The line-number gutter drops its own digits once a marker with a
    // toDOM occupies the line (see the module header), so this marker
    // re-renders them itself.
    const number = document.createElement('span')
    number.className = 'cm-textAnnotation-gutterMarker-number'
    number.textContent = this.lineNumberLabel
    wrapper.appendChild(number)

    const badge = document.createElement('span')
    badge.className = 'cm-textAnnotation-gutterMarker-badge'
    if (this.kind === 'overlapping') {
      badge.textContent = String(this.count)
      badge.title = `${this.count} annotations`
    } else if (this.kind === 'orphaned') {
      badge.textContent = String(this.ordinals[0])
      badge.title = `Annotation ${this.ordinals[0]} — target lost, needs reattaching`
    } else {
      badge.textContent = String(this.ordinals[0])
      badge.title = `Annotation ${this.ordinals[0]}`
    }
    wrapper.appendChild(badge)

    return wrapper
  }
}

const markClass = (active: boolean, resolved: boolean): string => [
  'cm-textAnnotation-mark',
  active ? 'cm-textAnnotation-mark-active' : '',
  resolved ? 'cm-textAnnotation-mark-resolved' : ''
].filter(part => part !== '').join(' ')

/**
 * Recomputes decorations and gutter markers from the current annotation
 * state. Grouping is by target line, not by character overlap: the
 * line-number gutter has exactly one row per source line, so two
 * annotations whose targets start on the same line collapse to one marker
 * regardless of whether their ranges actually overlap — that is what "one
 * marker carrying the count" means on a gutter that CodeMirror already owns.
 */
function buildFieldValue (base: TextAnnotationsState, doc: EditorState['doc']): TextAnnotationsFieldValue {
  const visible = base.annotations.filter(a => a.state === 'open' || base.showResolved)

  const ordinalByAnnotationId = new Map<string, number>()
  visible.forEach((annotation, index) => ordinalByAnnotationId.set(annotation.annotationId, index + 1))

  const markRanges: Array<ReturnType<Decoration['range']>> = []
  const groupsByLine = new Map<number, TextAnnotation[]>()

  for (const annotation of visible) {
    const anchor = annotation.anchor
    let lineNumber: number

    if (anchor.state === 'range') {
      // ponytail: clamp rather than defer. A broadcast can momentarily
      // outrun this pane's own unsynced keystrokes (the collaboration
      // service maps anchors against ITS working text, which this buffer is
      // usually but not instantaneously equal to); an out-of-bounds range
      // would throw out of `Decoration.mark`. Unlike a review decision, a
      // locator carries no adjudication that must bind to exact bytes, so a
      // clamped render for one tick until the next (already in-flight)
      // broadcast corrects it is an acceptable simplification over
      // replicating review's pending-session queue here.
      const from = Math.min(anchor.from, doc.length)
      const to = Math.min(anchor.to, doc.length)
      lineNumber = doc.lineAt(from).number
      if (from < to) {
        markRanges.push(
          Decoration.mark({ class: markClass(annotation.annotationId === base.activeAnnotationId, annotation.state === 'resolved') })
            .range(from, to)
        )
      }
    } else if (anchor.state === 'point') {
      lineNumber = doc.lineAt(Math.min(anchor.at, doc.length)).number
    } else {
      // Orphaned: no position survived. Line 1 is the one deterministic
      // location every document has to hang the locator on.
      lineNumber = 1
    }

    const group = groupsByLine.get(lineNumber)
    if (group === undefined) {
      groupsByLine.set(lineNumber, [annotation])
    } else {
      group.push(annotation)
    }
  }

  const gutterRanges: Array<ReturnType<GutterMarker['range']>> = []
  for (const [lineNumber, group] of groupsByLine) {
    const pos = doc.line(lineNumber).from
    const active = group.some(a => a.annotationId === base.activeAnnotationId)
    const resolved = group.every(a => a.state === 'resolved')
    const kind: MarkerKind = group.length > 1
      ? 'overlapping'
      : group[0].anchor.state === 'point'
        ? 'point'
        : group[0].anchor.state === 'orphaned'
          ? 'orphaned'
          : 'range'
    const ordinals = group
      .map(a => ordinalByAnnotationId.get(a.annotationId) ?? 0)
      .sort((a, b) => a - b)
    gutterRanges.push(
      new AnnotationGutterMarker(String(lineNumber), kind, group.length, ordinals, active, resolved).range(pos)
    )
  }

  if (base.draftRange !== null && base.draftRange.from < base.draftRange.to) {
    markRanges.push(Decoration.mark({ class: 'cm-textAnnotation-draft' }).range(base.draftRange.from, base.draftRange.to))
  }

  return {
    ...base,
    decorations: Decoration.set(markRanges, true),
    gutterMarkers: RangeSet.of(gutterRanges, true)
  }
}

const emptyState: TextAnnotationsState = {
  annotations: [],
  activeAnnotationId: null,
  draftRange: null,
  showResolved: false
}

const textAnnotationsField = StateField.define<TextAnnotationsFieldValue>({
  create (state) {
    return buildFieldValue(emptyState, state.doc)
  },
  update (value, tr) {
    let next: TextAnnotationsState = value

    if (tr.docChanged) {
      const annotations = value.annotations.map(annotation => {
        const mapped = mapAnnotationThroughChanges(annotation.anchor, tr.changes)
        return mapped.changed ? { ...annotation, anchor: mapped.anchor } : annotation
      })
      // ponytail: a draft that collapses under an edit (its two edges met)
      // is simply cleared rather than re-anchored to a point — it is not an
      // annotation yet, so there is nothing for a Reattach-style recovery to
      // act on, and the composer that owns it re-derives the range from the
      // live selection on its own next tick.
      const draftRange = value.draftRange === null
        ? null
        : (() => {
            const from = tr.changes.mapPos(value.draftRange.from, 1)
            const to = tr.changes.mapPos(value.draftRange.to, -1)
            return from < to ? { from, to } : null
          })()
      next = { ...next, annotations, draftRange }
    }

    for (const effect of tr.effects) {
      if (effect.is(setAnnotationSessionEffect)) {
        next = { ...next, annotations: effect.value.items }
      } else if (effect.is(setActiveAnnotationEffect)) {
        next = { ...next, activeAnnotationId: effect.value }
      } else if (effect.is(setAnnotationDraftEffect)) {
        next = { ...next, draftRange: effect.value }
      } else if (effect.is(clearAnnotationDraftEffect)) {
        next = { ...next, draftRange: null }
      } else if (effect.is(showResolvedAnnotationsEffect)) {
        next = { ...next, showResolved: effect.value }
      }
    }

    return next === value ? value : buildFieldValue(next, tr.state.doc)
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.decorations),
    lineNumberMarkers.from(field, value => value.gutterMarkers)
  ]
})

/** The field's current annotation-locator state, or `null` if not installed. */
export function getTextAnnotationsState (state: EditorState): TextAnnotationsState | null {
  return state.field(textAnnotationsField, false) ?? null
}

export function textAnnotationsExtension (): Extension {
  return [ textAnnotationsField, textAnnotationsTheme ]
}

const textAnnotationsTheme = EditorView.baseTheme({
  '.cm-textAnnotation-mark': {
    backgroundColor: 'var(--zettlr-editor-annotation-mark-bg)',
    borderRadius: '2px'
  },
  '.cm-textAnnotation-mark-active': {
    backgroundColor: 'var(--zettlr-editor-annotation-mark-active-bg)'
  },
  '.cm-textAnnotation-mark-resolved': {
    backgroundColor: 'var(--zettlr-editor-annotation-mark-resolved-bg)'
  },
  '.cm-textAnnotation-draft': {
    borderBottom: '2px dotted var(--zettlr-editor-annotation-draft-border)'
  },
  '.cm-textAnnotation-gutterMarker': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '3px',
    paddingRight: '2px'
  },
  '.cm-textAnnotation-gutterMarker-number': {
    opacity: '0.7'
  },
  '.cm-textAnnotation-gutterMarker-badge': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '1.15em',
    height: '1.15em',
    borderRadius: '50%',
    fontSize: '0.75em',
    lineHeight: '1',
    padding: '0 2px',
    boxSizing: 'content-box',
    backgroundColor: 'var(--zettlr-editor-annotation-marker-bg)',
    color: 'var(--zettlr-editor-annotation-marker-fg)'
  },
  '.cm-textAnnotation-gutterMarker-active .cm-textAnnotation-gutterMarker-badge': {
    outline: '2px solid var(--zettlr-editor-annotation-marker-active-bg)',
    outlineOffset: '1px'
  },
  '.cm-textAnnotation-gutterMarker-resolved .cm-textAnnotation-gutterMarker-badge': {
    backgroundColor: 'var(--zettlr-editor-annotation-marker-resolved-bg)',
    color: 'var(--zettlr-editor-annotation-marker-resolved-fg)'
  },
  '.cm-textAnnotation-gutterMarker-orphaned .cm-textAnnotation-gutterMarker-badge': {
    backgroundColor: 'transparent',
    border: '1.5px dashed var(--zettlr-editor-annotation-marker-orphaned-fg)',
    color: 'var(--zettlr-editor-annotation-marker-orphaned-fg)'
  },
  '.cm-textAnnotation-gutterMarker-point .cm-textAnnotation-gutterMarker-badge': {
    backgroundColor: 'transparent',
    border: '1.5px solid var(--zettlr-editor-annotation-marker-bg)',
    color: 'var(--zettlr-editor-annotation-marker-bg)'
  },
  '.cm-textAnnotation-gutterMarker-overlapping .cm-textAnnotation-gutterMarker-badge': {
    fontWeight: 'bold'
  }
})

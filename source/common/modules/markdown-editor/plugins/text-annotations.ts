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
 *                  Everything the owner reads, replies to or decides lives
 *                  in the annotations panel; this field distinguishes the
 *                  seven editor states plan section 3 requires and owns one
 *                  gesture: a click on a chip reports which annotation it
 *                  carries (`annotationChipClickedEffect`) and changes
 *                  nothing itself. Selection, drafting, and the
 *                  resolved-visibility toggle are driven by effects a host
 *                  (the panel, the creation composer) dispatches.
 *
 *                  The ordinal chip sits in a gutter of its own
 *                  (`cm-textAnnotation-gutter`), so it is there whether or
 *                  not the line-number gutter is switched on — the Markdown
 *                  editor shows no line numbers by default, and a marker
 *                  riding that gutter was invisible in the app.
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
import { Decoration, type DecorationSet, EditorView, gutter, GutterMarker } from '@codemirror/view'
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

/**
 * Reported when the owner clicks a gutter chip: the annotation that chip
 * carries. The field acts on nothing — the host opens the panel on it.
 */
export const annotationChipClickedEffect = StateEffect.define<string>()

export interface TextAnnotationsState {
  annotations: TextAnnotation[]
  activeAnnotationId: string | null
  draftRange: { from: number, to: number } | null
  showResolved: boolean
}

interface TextAnnotationsFieldValue extends TextAnnotationsState {
  decorations: DecorationSet
  gutterMarkers: RangeSet<GutterMarker>
  /**
   * The annotation each chip stands for, by the start of the line it sits
   * on: what a click on that gutter row resolves to. A chip carrying
   * several annotations answers with the one whose ordinal is lowest, the
   * first of the group the panel lists.
   */
  annotationIdByLine: Map<number, string>
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

    wrapper.dataset.line = this.lineNumberLabel

    // The chip: a comment glyph and the ordinal the card carries (S4). The
    // glyph is a registered Clarity icon, so the chip's text is the ordinal
    // alone.
    const badge = document.createElement('span')
    badge.className = 'cm-textAnnotation-gutterMarker-badge'
    const glyph = document.createElement('cds-icon')
    glyph.className = 'cm-textAnnotation-gutterMarker-glyph'
    glyph.setAttribute('shape', 'chat-bubble')
    glyph.setAttribute('role', 'presentation')
    badge.appendChild(glyph)
    const ordinal = document.createElement('span')
    ordinal.className = 'cm-textAnnotation-gutterMarker-ordinal'
    if (this.kind === 'overlapping') {
      ordinal.textContent = String(this.count)
      badge.title = `${this.count} annotations`
    } else if (this.kind === 'orphaned') {
      ordinal.textContent = String(this.ordinals[0])
      badge.title = `Annotation ${this.ordinals[0]} — target lost, needs reattaching`
    } else {
      ordinal.textContent = String(this.ordinals[0])
      badge.title = `Annotation ${this.ordinals[0]}`
    }
    badge.appendChild(ordinal)
    wrapper.appendChild(badge)

    return wrapper
  }
}

/** The block tint of the active target's lines, with its left accent bar. */
const activeLineDecoration = Decoration.line({ class: 'cm-textAnnotation-activeLine' })

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

  /**
   * An annotation's number as the panel counts it: its place in the visible
   * list, one-based. Every annotation a marker groups came out of that list.
   */
  const ordinalOf = (annotation: TextAnnotation): number => {
    const index = visible.indexOf(annotation)
    if (index === -1) {
      throw new Error(
        `A grouped annotation is not in the list it was grouped from: ${annotation.annotationId}. ` +
        'The groups are built from `visible` in this function; a member that is not in it means the ' +
        'grouping copied an annotation instead of carrying the element.'
      )
    }
    return index + 1
  }

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
      const active = annotation.annotationId === base.activeAnnotationId
      if (from < to) {
        markRanges.push(
          Decoration.mark({ class: markClass(active, annotation.state === 'resolved') })
            .range(from, to)
        )
      }
      if (active) {
        // The active target's block tint: every line its range touches.
        const lastLine = doc.lineAt(Math.max(from, to - 1)).number
        for (let line = lineNumber; line <= lastLine; line++) {
          markRanges.push(activeLineDecoration.range(doc.line(line).from))
        }
      }
    } else if (anchor.state === 'point') {
      lineNumber = doc.lineAt(Math.min(anchor.at, doc.length)).number
      if (annotation.annotationId === base.activeAnnotationId) {
        markRanges.push(activeLineDecoration.range(doc.line(lineNumber).from))
      }
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
  const annotationIdByLine = new Map<number, string>()
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
    const byOrdinal = [...group].sort((a, b) => ordinalOf(a) - ordinalOf(b))
    const ordinals = byOrdinal.map(ordinalOf)
    annotationIdByLine.set(pos, byOrdinal[0].annotationId)
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
    gutterMarkers: RangeSet.of(gutterRanges, true),
    annotationIdByLine
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
    EditorView.decorations.from(field, value => value.decorations)
  ]
})

/**
 * The annotation chips' own gutter, present with or without line numbers.
 * A click on a chip reports its annotation and consumes the event, so the
 * gesture never also moves the cursor into the line behind it.
 */
const textAnnotationsGutter = gutter({
  class: 'cm-textAnnotation-gutter',
  markers: view => view.state.field(textAnnotationsField).gutterMarkers,
  domEventHandlers: {
    mousedown (view, line) {
      const annotationId = view.state.field(textAnnotationsField).annotationIdByLine.get(line.from)
      if (annotationId === undefined) {
        return false
      }
      view.dispatch({ effects: annotationChipClickedEffect.of(annotationId) })
      return true
    }
  }
})

/** The field's current annotation-locator state, or undefined if not installed. */
export function getTextAnnotationsState (state: EditorState): TextAnnotationsState | undefined {
  return state.field(textAnnotationsField, false)
}

export function textAnnotationsExtension (): Extension {
  return [ textAnnotationsField, textAnnotationsGutter, textAnnotationsTheme ]
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
  '.cm-textAnnotation-activeLine': {
    backgroundColor: 'var(--zettlr-editor-annotation-line-active-bg)',
    boxShadow: 'inset 3px 0 0 var(--zettlr-editor-annotation-marker-active-bg)'
  },
  '.cm-textAnnotation-gutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px'
  },
  '.cm-textAnnotation-gutterMarker': {
    display: 'flex',
    alignItems: 'center'
  },
  // The chip: a rounded square carrying the comment glyph and the ordinal.
  '.cm-textAnnotation-gutterMarker-badge': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    gap: '2px',
    height: '1.3em',
    borderRadius: '4px',
    fontSize: '0.72em',
    fontWeight: '600',
    lineHeight: '1',
    padding: '0 4px',
    boxSizing: 'content-box',
    backgroundColor: 'var(--zettlr-editor-annotation-marker-bg)',
    color: 'var(--zettlr-editor-annotation-marker-fg)'
  },
  '.cm-textAnnotation-gutterMarker-glyph': {
    width: '1em',
    height: '1em',
    color: 'inherit'
  },
  '.cm-textAnnotation-gutterMarker-active .cm-textAnnotation-gutterMarker-badge': {
    backgroundColor: 'var(--zettlr-editor-annotation-marker-active-bg)',
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

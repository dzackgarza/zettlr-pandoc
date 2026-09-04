/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor text-annotation locator specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Mounts the production text-annotations CodeMirror plugin
 *                  and proves the editor distinguishes the seven states plan
 *                  section 3 requires: open/inactive, open/active,
 *                  overlapping, point-target, drafting, orphaned, and
 *                  resolved. Also proves I4 — the editor renders no message
 *                  text, thread, button, or proposal state, only the
 *                  locator — and that a local edit maps a target's highlight
 *                  and marker without a fresh broadcast.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import type { AnnotationAnchor, AnnotationSet, TextAnnotation } from '@dts/common/annotation-domain'
import {
  clearAnnotationDraftEffect,
  getTextAnnotationsState,
  setActiveAnnotationEffect,
  setAnnotationDraftEffect,
  setAnnotationSessionEffect,
  showResolvedAnnotationsEffect,
  textAnnotationsExtension
} from 'source/common/modules/markdown-editor/plugins/text-annotations'

function polyfillJsdomForCodeMirror (): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      Number(setTimeout(() => callback(Date.now()), 0))
    globalThis.cancelAnimationFrame = (id: number): void => { clearTimeout(id) }
  }
  if (typeof globalThis.window === 'object' && typeof globalThis.window.requestAnimationFrame !== 'function') {
    globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame
    globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame
  }
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    }
    if (typeof globalThis.window === 'object') {
      globalThis.window.ResizeObserver = globalThis.ResizeObserver
    }
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    class EmptyDOMRectList extends Array<DOMRect> {
      item (): DOMRect | null {
        return null
      }
    }
    Range.prototype.getClientRects = function (): DOMRectList {
      return new EmptyDOMRectList()
    }
    Range.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
    }
  }
}

let counter = 0

/** A representative TextAnnotation. Only the anchor and overrides vary per case. */
function annotation (anchor: AnnotationAnchor, overrides: Partial<TextAnnotation> = {}): TextAnnotation {
  counter += 1
  return {
    annotationId: `annotation-${counter}`,
    documentId: 'doc-1',
    anchor,
    state: 'open',
    messages: [{ messageId: `msg-${counter}`, author: 'owner', text: 'Justify this claim.', createdAt: '2026-01-01T00:00:00.000Z' }],
    proposalActions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function session (items: TextAnnotation[]): AnnotationSet {
  return { generation: items.length, items }
}

describe('Editor text-annotation locators', function () {
  const views: EditorView[] = []

  before(function () {
    polyfillJsdomForCodeMirror()
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function mount (doc: string): EditorView {
    const state = EditorState.create({ doc, extensions: [ lineNumbers(), textAnnotationsExtension() ] })
    const view = new EditorView({ state, parent: document.body })
    views.push(view)
    return view
  }

  /** The gutter row for a given 1-based source line, or null if it carries no marker. */
  function markerOnLine (view: EditorView, line: number): HTMLElement | null {
    for (const marker of view.dom.querySelectorAll<HTMLElement>('.cm-textAnnotation-gutterMarker')) {
      if (marker.querySelector('.cm-textAnnotation-gutterMarker-number')?.textContent === String(line)) {
        return marker
      }
    }
    return null
  }

  const DOC = [
    'The quick brown fox jumps over the lazy dog.', // line 1
    'A second line with a target phrase in it.',    // line 2
    'A third line.'                                 // line 3
  ].join('\n')

  it('invariant I4: renders no message text, thread, button, or proposal state — only the locator', function () {
    const view = mount(DOC)
    const from = DOC.indexOf('target phrase')
    const item = annotation({ state: 'range', from, to: from + 'target phrase'.length, quotedText: 'target phrase' }, {
      messages: [{ messageId: 'm1', author: 'owner', text: 'Please justify this claim with a citation.', createdAt: '2026-01-01T00:00:00.000Z' }]
    })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })

    assert.equal(view.dom.querySelectorAll('button').length, 0, 'no adjudication or thread control renders in the editor')
    assert.equal(view.dom.textContent?.includes('Please justify this claim with a citation.'), false, 'the owner instruction is panel content, never editor content')
  })

  it('open/inactive: highlights the target span and marks its first line with the card ordinal', function () {
    const view = mount(DOC)
    const from = DOC.indexOf('target phrase')
    const to = from + 'target phrase'.length
    const item = annotation({ state: 'range', from, to, quotedText: 'target phrase' })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })

    const mark = view.dom.querySelector<HTMLElement>('.cm-textAnnotation-mark')
    assert.ok(mark !== null, 'expected a span highlight over the target')
    assert.equal(mark?.textContent, 'target phrase')
    assert.equal(mark?.classList.contains('cm-textAnnotation-mark-active'), false)

    const marker = markerOnLine(view, 2)
    assert.ok(marker !== null, 'expected a gutter marker on the target\'s first line')
    assert.ok(marker?.classList.contains('cm-textAnnotation-gutterMarker-range'))
    assert.equal(marker?.querySelector('.cm-textAnnotation-gutterMarker-badge')?.textContent, '1', 'the marker carries the card\'s ordinal')
  })

  it('open/active: gives the active annotation\'s mark and marker a stronger treatment than open/inactive', function () {
    const view = mount(DOC)
    const from = DOC.indexOf('target phrase')
    const item = annotation({ state: 'range', from, to: from + 'target phrase'.length, quotedText: 'target phrase' })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })
    view.dispatch({ effects: setActiveAnnotationEffect.of(item.annotationId) })

    assert.ok(view.dom.querySelector('.cm-textAnnotation-mark-active') !== null)
    assert.ok(markerOnLine(view, 2)?.classList.contains('cm-textAnnotation-gutterMarker-active'))

    view.dispatch({ effects: setActiveAnnotationEffect.of(null) })
    assert.equal(view.dom.querySelector('.cm-textAnnotation-mark-active'), null, 'clearing the active id removes the stronger treatment')
    assert.equal(markerOnLine(view, 2)?.classList.contains('cm-textAnnotation-gutterMarker-active'), false)
  })

  it('overlapping: two targets on the same line collapse to one marker carrying the count, while both spans still highlight', function () {
    const view = mount(DOC)
    const quickFrom = DOC.indexOf('quick')
    const foxFrom = DOC.indexOf('fox')
    const first = annotation({ state: 'range', from: quickFrom, to: quickFrom + 'quick'.length, quotedText: 'quick' })
    const second = annotation({ state: 'range', from: foxFrom, to: foxFrom + 'fox'.length, quotedText: 'fox' })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ first, second ])) })

    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-mark').length, 2, 'each target still highlights individually')
    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-gutterMarker').length, 1, 'one line collapses to one marker')

    const marker = markerOnLine(view, 1)
    assert.ok(marker?.classList.contains('cm-textAnnotation-gutterMarker-overlapping'))
    assert.equal(marker?.querySelector('.cm-textAnnotation-gutterMarker-badge')?.textContent, '2', 'the marker carries the count')
  })

  it('point target: marks the deletion seam and highlights no span', function () {
    const view = mount(DOC)
    const seam = DOC.indexOf('target phrase')
    const item = annotation({ state: 'point', at: seam, quotedText: 'target phrase', reason: 'target-deleted' })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })

    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-mark').length, 0, 'a point target has no span to highlight')
    const marker = markerOnLine(view, 2)
    assert.ok(marker?.classList.contains('cm-textAnnotation-gutterMarker-point'))
    assert.equal(marker?.querySelector('.cm-textAnnotation-gutterMarker-badge')?.textContent, '1')
  })

  it('orphaned: marks the document\'s first line and highlights no span, since no position survived', function () {
    const view = mount(DOC)
    const item = annotation({ state: 'orphaned', quotedText: 'target phrase', reason: 'external-drift' })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })

    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-mark').length, 0)
    const marker = markerOnLine(view, 1)
    assert.ok(marker !== null, 'expected the orphaned locator to render at the document\'s one deterministic line')
    assert.ok(marker?.classList.contains('cm-textAnnotation-gutterMarker-orphaned'))
    assert.equal(marker?.querySelector('.cm-textAnnotation-gutterMarker-badge')?.textContent, '1', 'still carries an ordinal, for identification with its card')
  })

  it('resolved: renders nothing until "Show resolved" is on, then renders distinguishably from open', function () {
    const view = mount(DOC)
    const from = DOC.indexOf('target phrase')
    const item = annotation(
      { state: 'range', from, to: from + 'target phrase'.length, quotedText: 'target phrase' },
      { state: 'resolved', resolvedAt: '2026-01-02T00:00:00.000Z' }
    )
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })

    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-mark').length, 0, 'resolved is invisible by default')
    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-gutterMarker').length, 0)

    view.dispatch({ effects: showResolvedAnnotationsEffect.of(true) })
    const mark = view.dom.querySelector('.cm-textAnnotation-mark')
    assert.ok(mark !== null)
    assert.ok(mark?.classList.contains('cm-textAnnotation-mark-resolved'))
    assert.ok(markerOnLine(view, 2)?.classList.contains('cm-textAnnotation-gutterMarker-resolved'))
  })

  it('drafting: shows a transient treatment on the selection, with no marker, cleared on cancel', function () {
    const view = mount(DOC)
    const from = DOC.indexOf('second line')
    const to = from + 'second line'.length
    view.dispatch({ effects: setAnnotationDraftEffect.of({ from, to }) })

    const draft = view.dom.querySelector<HTMLElement>('.cm-textAnnotation-draft')
    assert.ok(draft !== null)
    assert.equal(draft?.textContent, 'second line')
    assert.equal(view.dom.querySelectorAll('.cm-textAnnotation-gutterMarker').length, 0, 'a draft is not yet a card and carries no ordinal')

    view.dispatch({ effects: clearAnnotationDraftEffect.of(null) })
    assert.equal(view.dom.querySelector('.cm-textAnnotation-draft'), null)
  })

  it('local mapping: an interior edit grows the highlighted span and the marker follows the retargeted line without a fresh broadcast', function () {
    const view = mount(DOC)
    const from = DOC.indexOf('target phrase')
    const to = from + 'target phrase'.length
    const item = annotation({ state: 'range', from, to, quotedText: 'target phrase' })
    view.dispatch({ effects: setAnnotationSessionEffect.of(session([ item ])) })

    // Insert a new first line, pushing the target from line 2 to line 3.
    view.dispatch({ changes: { from: 0, insert: 'A brand new opening line.\n' } })
    assert.equal(markerOnLine(view, 2), null, 'the old line no longer carries the marker')
    const shifted = markerOnLine(view, 3)
    assert.ok(shifted !== null, 'the marker followed the target to its new line')
    assert.equal(shifted?.querySelector('.cm-textAnnotation-gutterMarker-badge')?.textContent, '1')

    // Type inside the target: the annotation is a comment ABOUT the stretch,
    // so an interior insertion grows the range rather than splitting around it.
    const insertionPoint = view.state.doc.toString().indexOf('target phrase') + 'target '.length
    view.dispatch({ changes: { from: insertionPoint, insert: 'exact ' } })
    const mark = view.dom.querySelector<HTMLElement>('.cm-textAnnotation-mark')
    assert.equal(mark?.textContent, 'target exact phrase')

    const mapped = getTextAnnotationsState(view.state)?.annotations[0]
    assert.equal(mapped?.anchor.state, 'range')
    if (mapped?.anchor.state === 'range') {
      assert.equal(mapped.anchor.quotedText, 'target phrase', 'I1: quotedText is never rewritten')
    }
  })
})

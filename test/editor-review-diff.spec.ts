/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor review-chunk locator specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Mounts the production CodeMirror review-chunks plugin and
 *                  exercises only behavior owned by the editor view: where a
 *                  chunk's marks land, how they map through the owner's own
 *                  typing, chunk navigation, and preview suppression.
 *
 *                  The plugin renders locators and nothing else (plan
 *                  invariant I4), so the decisive claim here is a negative
 *                  one: no button, no field, and no panel appears inside the
 *                  editor for any chunk shape. Adjudication itself — the
 *                  decisions, the notes, the mass actions, the review
 *                  comment — is the annotations panel's, and is proved in
 *                  annotations-sidebar.spec.ts against the real IPC bridge.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ReviewSuggestionView } from '@dts/common/review-diff'
import {
  getReviewChunks,
  reviewChunksExtension,
  selectNextReviewChunk,
  selectPreviousReviewChunk
} from 'source/common/modules/markdown-editor/plugins/review-chunks'
import { rangeInPreviewSuppression } from 'source/common/modules/markdown-editor/util/range-in-preview-suppression'
import { renderLinks } from 'source/common/modules/markdown-editor/renderers/render-links'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'

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
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({})
      }
    }
  }
}

function replacementSuggestion (
  workingText: string,
  removedText: string,
  insertedText: string,
  suggestionId = `suggestion-${insertedText || removedText}`,
  description = 'proposal'
): ReviewSuggestionView {
  const seam = insertedText === ''
    ? workingText.indexOf(workingText.trimEnd().split('\n').at(-1) ?? '')
    : workingText.indexOf(insertedText)
  assert.notEqual(seam, -1, `fixture text not found: ${insertedText}`)
  return {
    suggestionId,
    removedText,
    anchors: insertedText === '' ? [] : [{ from: seam, to: seam + insertedText.length }],
    seam,
    description
  }
}

describe('Editor review-chunk view', function () {
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

  function createReviewView (
    workingText: string,
    suggestions: ReviewSuggestionView[]
  ): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: workingText,
        extensions: [
          reviewChunksExtension({ suggestions }),
          EditorView.updateListener.of(() => {})
        ]
      })
    })
    views.push(view)
    return view
  }

  function chunksOf (view: EditorView): NonNullable<ReturnType<typeof getReviewChunks>> {
    const chunks = getReviewChunks(view.state)
    assert.ok(chunks !== null, 'the editor must be in review mode')
    return chunks
  }

  /**
   * Everything in a review pane that could adjudicate a chunk. I4 admits
   * locators only, so each of these must be zero for every chunk shape — a
   * replacement, a pure deletion, a heavy rewrite, several chunks at once.
   * `.cm-panels` catches the status bar specifically: a panel mounts
   * OUTSIDE the scroller, so a control count taken from the content alone
   * would miss it.
   */
  function adjudicationControlsIn (view: EditorView): {
    buttons: number
    fields: number
    panels: number
  } {
    return {
      buttons: view.dom.querySelectorAll('button').length,
      fields: view.dom.querySelectorAll('input, textarea, select').length,
      panels: view.dom.querySelectorAll('.cm-panels').length
    }
  }

  it('locates every chunk and adjudicates none of them (I4)', function () {
    const baseline = [
      '# Note', '', 'first baseline', '', 'middle unchanged', '', 'second baseline', ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const suggestions = [
      replacementSuggestion(proposed, 'baseline', 'proposed', 'first-change'),
      replacementSuggestion(proposed.slice(proposed.indexOf('middle unchanged')), 'baseline', 'proposed', 'second-change')
    ]
    suggestions[1].anchors = suggestions[1].anchors.map(anchor => ({
      from: anchor.from + proposed.indexOf('middle unchanged'),
      to: anchor.to + proposed.indexOf('middle unchanged')
    }))
    suggestions[1].seam += proposed.indexOf('middle unchanged')
    const view = createReviewView(proposed, suggestions)
    assert.equal(chunksOf(view).length, 2)

    // Both chunks are located: each shows what it takes out and what it puts
    // in, at the position it lands on.
    assert.deepEqual(
      [...view.dom.querySelectorAll<HTMLElement>('del.cm-deletedText')].map(el => el.textContent),
      ['baseline', 'baseline']
    )
    assert.deepEqual(
      [...view.dom.querySelectorAll<HTMLElement>('.cm-changedText')].map(el => el.textContent),
      ['proposed', 'proposed']
    )

    assert.deepEqual(
      adjudicationControlsIn(view),
      { buttons: 0, fields: 0, panels: 0 },
      'the editor carries locators only: the panel owns every decision'
    )
  })

  it('maps a local owner insertion out of the rendered suggestion immediately', function () {
    const working = 'prefix AGENT suffix\n'
    const suggestion = replacementSuggestion(working, '', 'AGENT', 'agent-text')
    const view = createReviewView(working, [suggestion])
    const insertAt = working.indexOf('AGENT') + 2
    view.dispatch({ changes: { from: insertAt, insert: 'USER' } })

    const [mapped] = chunksOf(view)
    assert.deepEqual(mapped.anchors, [
      { from: working.indexOf('AGENT'), to: insertAt },
      { from: insertAt + 4, to: working.indexOf('AGENT') + 5 + 4 }
    ])
    assert.equal(
      mapped.anchors.map(anchor => view.state.doc.sliceString(anchor.from, anchor.to)).join(''),
      'AGENT'
    )
  })

  it('never marks a region the user typed (#65)', function () {
    // Adjudication is a decision about a proposal. A paragraph the reviewer
    // edited themselves disagrees with the frozen reference just as loudly,
    // but no packet claims it — so it carries no mark and no place in the
    // outstanding set.
    const working = 'first proposed\n\nsecond typed by hand\n'
    const view = createReviewView(working, [replacementSuggestion(
      working,
      'baseline',
      'proposed',
      'opening',
      'Sharpen the opening claim'
    )])

    const chunks = chunksOf(view)
    assert.equal(chunks.length, 1, 'only the attributed edit is adjudicable')
    assert.equal(view.state.doc.sliceString(chunks[0].anchors[0].from, chunks[0].anchors[0].to), 'proposed')
    assert.deepEqual(
      [...view.dom.querySelectorAll<HTMLElement>('.cm-changedText')].map(el => el.textContent),
      ['proposed'],
      'the user\'s own paragraph is not marked as a proposal'
    )
    const typedLine = view.state.doc.line(3)
    assert.equal(
      rangeInPreviewSuppression(view.state, typedLine.from, typedLine.to),
      false,
      'the user\'s own paragraph keeps its live preview'
    )
  })

  it('renders a small replacement as inline track changes', function () {
    const baseline = ['alpha', '', 'the original wording stays here', ''].join('\n')
    const proposed = baseline.replace('original wording', 'revised wording')
    const view = createReviewView(proposed, [
      replacementSuggestion(proposed, 'original', 'revised', 'wording', 'Revise the wording')
    ])

    assert.equal(view.dom.querySelector('.cm-deletedChunk'), null, 'the delta renders in the document flow, not a block above it')
    const deleted = view.dom.querySelector<HTMLElement>('del.cm-deletedText')
    assert.ok(deleted !== null)
    assert.equal(deleted.textContent, 'original')
    const line = deleted.closest<HTMLElement>('.cm-line')
    assert.ok(line !== null, 'the strikethrough sits inside the working line')
    assert.equal(
      line.textContent,
      'the originalrevised wording stays here',
      'the deleted span reads before its replacement, in one pass'
    )
    assert.deepEqual(adjudicationControlsIn(view), { buttons: 0, fields: 0, panels: 0 })
  })

  it('renders a whole-line deletion as inline strikethrough', function () {
    const working = 'prefix\nunchanged\n'
    const view = createReviewView(working, [{
      suggestionId: 'removed-lines',
      removedText: 'first removed\nsecond removed',
      anchors: [{
        from: working.indexOf('unchanged'),
        to: working.indexOf('unchanged')
      }],
      seam: working.indexOf('unchanged'),
      description: 'proposal'
    }])

    assert.equal(view.dom.querySelector('.cm-deletedChunk'), null)
    const deleted = view.dom.querySelectorAll<HTMLElement>('del.cm-deletedText')
    assert.equal(deleted.length, 1)
    assert.equal(deleted[0].textContent, 'first removed\nsecond removed')
    assert.deepEqual(adjudicationControlsIn(view), { buttons: 0, fields: 0, panels: 0 })
  })

  it('keeps a heavy rewrite merged in the document flow', function () {
    const working = 'completely different words now\n'
    const view = createReviewView(working, [
      replacementSuggestion(working, 'alpha beta gamma delta', 'completely different words now')
    ])

    assert.equal(view.dom.querySelector('.cm-deletedChunk'), null)
    const deleted = view.dom.querySelector<HTMLElement>('del.cm-deletedText')
    assert.equal(deleted?.textContent, 'alpha beta gamma delta')
    const line = deleted?.closest<HTMLElement>('.cm-line')
    assert.ok(line !== null && line !== undefined, 'the deleted span sits inside a document line')
    const lineText = line.textContent
    assert.ok(lineText !== null && lineText.includes('completely different words now'))
    assert.deepEqual(adjudicationControlsIn(view), { buttons: 0, fields: 0, panels: 0 })
  })

  it('suppresses live-preview rendering only over a range carrying a review chunk', function () {
    const baseline = [
      'intro paragraph', '', '$$', 'p_a(C) = 10', '$$', '', 'closing paragraph', ''
    ].join('\n')
    const proposed = baseline.replace('p_a(C) = 10', 'g(C) = 10')
    const view = createReviewView(proposed, [
      replacementSuggestion(proposed, 'p_a(C) = 10', 'g(C) = 10')
    ])

    assert.equal(
      rangeInPreviewSuppression(
        view.state,
        view.state.doc.line(3).from,
        view.state.doc.line(5).to
      ),
      true
    )
    const intro = view.state.doc.line(1)
    assert.equal(rangeInPreviewSuppression(view.state, intro.from, intro.to), false)
  })

  it('uses half-open chunk overlap while preserving deletion-point suppression', function () {
    const adjacentText = 'ALPHA\nunchanged'
    const adjacent = createReviewView(adjacentText, [
      replacementSuggestion(adjacentText, 'alpha', 'ALPHA')
    ])
    const unchanged = adjacent.state.doc.line(2)
    assert.equal(
      rangeInPreviewSuppression(adjacent.state, unchanged.from, unchanged.to),
      false
    )

    const deletionText = 'prefix\nunchanged'
    const deletion = createReviewView(deletionText, [{
      suggestionId: 'middle-deletion',
      removedText: 'removed\n',
      anchors: [{
        from: deletionText.indexOf('unchanged'),
        to: deletionText.indexOf('unchanged')
      }],
      seam: deletionText.indexOf('unchanged'),
      description: 'proposal'
    }])
    const surviving = deletion.state.doc.line(2)
    assert.equal(
      rangeInPreviewSuppression(deletion.state, surviving.from, surviving.to),
      true
    )

    const deletionAtEndText = 'prefix\nunchanged\ntail'
    const deletionAtEnd = createReviewView(deletionAtEndText, [{
      suggestionId: 'later-deletion',
      removedText: 'removed\n',
      anchors: [{
        from: deletionAtEndText.indexOf('tail'),
        to: deletionAtEndText.indexOf('tail')
      }],
      seam: deletionAtEndText.indexOf('tail'),
      description: 'proposal'
    }])
    const beforeDeletion = deletionAtEnd.state.doc.line(2)
    const deletionChunks = chunksOf(deletionAtEnd)
    assert.equal(deletionChunks.length, 1)
    assert.deepEqual(deletionChunks[0].anchors, [{
      from: deletionAtEndText.indexOf('tail'),
      to: deletionAtEndText.indexOf('tail')
    }])
    assert.equal(
      rangeInPreviewSuppression(
        deletionAtEnd.state,
        beforeDeletion.from,
        deletionChunks[0].seam
      ),
      false
    )
  })

  it('rebuilds preview renderers when a review arrives or clears without an edit', function () {
    // Reviews install and clear through compartment reconfiguration, which
    // changes no document, selection, or viewport — the renderer must still
    // rebuild, or widgets stay rendered over active chunks and hide their
    // marks (and stay raw after the review clears).
    const working = 'see [text](https://example.com) here\n'
    const reviewCompartment = new Compartment()
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: working,
        extensions: [ markdownParser(), renderLinks, reviewCompartment.of([]) ]
      })
    })
    views.push(view)
    const rawMarkers = (): boolean =>
      (view.contentDOM.textContent ?? '').includes('](https://example.com)')

    assert.equal(rawMarkers(), false, 'the link renders with hidden markers before a review exists')

    view.dispatch({
      effects: reviewCompartment.reconfigure(reviewChunksExtension({
        suggestions: [replacementSuggestion(working, 'old', 'text')]
      }))
    })
    assert.equal(
      rawMarkers(),
      true,
      'installing a review without an edit reveals the raw link under its chunk'
    )

    view.dispatch({ effects: reviewCompartment.reconfigure([]) })
    assert.equal(
      rawMarkers(),
      false,
      'clearing the review without an edit re-renders the link'
    )
  })

  it('navigates between chunks with next and previous, wrapping at both ends', function () {
    const baseline = [
      '# Note', '', 'first baseline', '', 'middle unchanged', '', 'second baseline', ''
    ].join('\n')
    const proposed = baseline
      .replace('first baseline', 'first proposed')
      .replace('second baseline', 'second proposed')
    const first = replacementSuggestion(proposed, 'baseline', 'proposed', 'first')
    const secondStart = proposed.indexOf('second proposed') + 'second '.length
    const view = createReviewView(proposed, [first, {
      suggestionId: 'second',
      removedText: 'baseline',
      anchors: [{ from: secondStart, to: secondStart + 'proposed'.length }],
      seam: secondStart,
      description: 'proposal'
    }])
    const chunks = chunksOf(view)
    const anchorOf = (index: number): number =>
      view.state.doc.lineAt(chunks[index].anchors[0]?.from ?? chunks[index].seam).from

    assert.equal(selectNextReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(0))
    assert.equal(selectNextReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(1))
    assert.equal(selectNextReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(0))
    assert.equal(selectPreviousReviewChunk(view), true)
    assert.equal(view.state.selection.main.head, anchorOf(1))
  })

  it('answers false from navigation commands outside a review', function () {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'plain text' })
    })
    views.push(view)
    assert.equal(selectNextReviewChunk(view), false)
    assert.equal(selectPreviousReviewChunk(view), false)
  })

  it('carries the styling scope as an editor attribute owned by CodeMirror', function () {
    // The class used to be added by hand on view.dom, where CodeMirror's
    // attribute syncing wiped it on the next re-measure or focus change.
    // Declared as an editorAttributes facet, CodeMirror itself maintains it.
    const compartment = new Compartment()
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'proposal\n',
        extensions: [compartment.of(reviewChunksExtension({
          suggestions: [replacementSuggestion('proposal\n', 'baseline', 'proposal')]
        }))]
      })
    })
    views.push(view)
    assert.ok(
      view.dom.classList.contains('review-diff-active'),
      'mounting the review extension is what styles the pane'
    )
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    assert.ok(
      view.dom.classList.contains('review-diff-active'),
      'the class survives updates because CodeMirror owns it'
    )
    view.dispatch({ effects: compartment.reconfigure([]) })
    assert.equal(
      view.dom.classList.contains('review-diff-active'),
      false,
      'removing the review removes its styling scope with it'
    )
  })

  it('drops a chunk\'s marks when the provider reports it decided', function () {
    // The provider's echo is the ONLY thing that resolves a chunk here: the
    // pane reconfigures from the new broadcast and the decided chunk's marks
    // leave with it. Nothing local decided anything.
    const compartment = new Compartment()
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'proposal\n',
        extensions: [compartment.of(reviewChunksExtension({
          suggestions: [replacementSuggestion('proposal\n', 'baseline', 'proposal')]
        }))]
      })
    })
    views.push(view)
    assert.equal(view.dom.querySelectorAll('del.cm-deletedText').length, 1)

    view.dispatch({
      effects: compartment.reconfigure(reviewChunksExtension({ suggestions: [] }))
    })
    assert.equal(chunksOf(view).length, 0)
    assert.equal(
      view.dom.querySelectorAll('del.cm-deletedText').length,
      0,
      'a resolved review leaves no mark behind'
    )
  })

  it('returns no preview suppression outside an active review', function () {
    const doc = ['intro paragraph', '', '$$', 'p_a(C) = 10', '$$', ''].join('\n')
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc })
    })
    views.push(view)
    assert.equal(
      rangeInPreviewSuppression(
        view.state,
        view.state.doc.line(3).from,
        view.state.doc.line(5).to
      ),
      false
    )
  })

  it('leaves unchanged document lines visible instead of folding them away', function () {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)
    const proposed = lines
      .map(line => line === 'line 30' ? 'line 30 corrected' : line)
      .join('\n')
    const view = createReviewView(proposed, [
      replacementSuggestion(proposed, 'line 30', 'line 30 corrected')
    ])

    assert.equal(chunksOf(view).length, 1)
    assert.equal(view.dom.querySelectorAll('.cm-collapsedLines').length, 0)
  })
})

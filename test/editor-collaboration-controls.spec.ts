/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor collaboration control placement specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Mounts the production review-chunks, text-annotations and
 *                  collaboration-controls extensions in one EditorView and
 *                  proves what the editor owns about the inline controls:
 *                  where each block lands in the document, which chunk or
 *                  annotation the host is asked to fill it for, when the
 *                  blocks are locked because the chunks no longer match the
 *                  provider's broadcast, and that a block the editor drops
 *                  is handed back to the host. The controls' content and
 *                  the actions behind it are proved end to end in the
 *                  review and annotation e2e specs.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ReviewSuggestionView } from '@dts/common/review-diff'
import type { TextAnnotation } from '@dts/common/annotation-domain'
import { reviewChunksExtension } from 'source/common/modules/markdown-editor/plugins/review-chunks'
import {
  setActiveAnnotationEffect,
  setAnnotationSessionEffect,
  textAnnotationsExtension
} from 'source/common/modules/markdown-editor/plugins/text-annotations'
import {
  collaborationControls,
  type CollaborationControl
} from 'source/common/modules/markdown-editor/plugins/collaboration-controls'

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

const WORKING = [
  '# Review', // 1
  '', // 2
  'alpha proposed', // 3
  '', // 4
  'bravo proposed first half', // 5
  'bravo proposed second half', // 6
  '', // 7
  'charlie unchanged' // 8
].join('\n')

function span (text: string): { from: number, to: number } {
  const from = WORKING.indexOf(text)
  assert.notEqual(from, -1, `fixture text not found: ${text}`)
  return { from, to: from + text.length }
}

/** Two chunks: one on line 3, one spanning lines 5 and 6. */
function suggestions (): ReviewSuggestionView[] {
  const alpha = span('proposed')
  const bravo = { from: WORKING.indexOf('proposed first'), to: span('bravo proposed second').to }
  return [
    { suggestionId: 'chunk-alpha', removedText: 'original', anchors: [alpha], seam: alpha.from, description: 'Revise alpha' },
    { suggestionId: 'chunk-bravo', removedText: 'original', anchors: [bravo], seam: bravo.from, description: 'Revise bravo' }
  ]
}

function annotation (annotationId: string, from: number, to: number, state: TextAnnotation['state'] = 'open'): TextAnnotation {
  return {
    annotationId,
    documentId: 'doc-1',
    anchor: { state: 'range', from, to, quotedText: WORKING.slice(from, to) },
    state,
    messages: [{ messageId: `${annotationId}-m1`, author: 'owner', text: 'Say which lattices these are.', createdAt: '2026-01-01T00:00:00.000Z' }],
    proposalActions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

/**
 * The host side of the contract, as the pane implements it: it fills a block
 * with content naming what it was placed for, and hands back the removal.
 */
class RecordingHost {
  readonly mounted: string[] = []
  readonly unmounted: string[] = []

  readonly mount = (dom: HTMLElement, control: CollaborationControl): (() => void) => {
    const label = control.kind === 'review-chunk'
      ? `chunk:${control.chunkId}`
      : control.kind === 'annotation-thread' ? `thread:${control.annotationId}` : 'review-bar'
    dom.textContent = label
    this.mounted.push(label)
    return () => { this.unmounted.push(label) }
  }
}

describe('Editor collaboration control placement', function () {
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

  function mount (host: RecordingHost, reviewCompartment: Compartment, chunks: ReviewSuggestionView[]): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: WORKING,
        extensions: [
          reviewCompartment.of(reviewChunksExtension({ suggestions: chunks })),
          textAnnotationsExtension(),
          collaborationControls(host.mount)
        ]
      })
    })
    views.push(view)
    return view
  }

  /** The source text of the document line rendered right before a block. */
  function lineAbove (view: EditorView, block: Element): string {
    const previous = block.previousElementSibling
    assert.ok(previous !== null && previous.classList.contains('cm-line'), 'a control block follows a document line')
    return view.state.doc.lineAt(view.posAtDOM(previous)).text
  }

  it('places one block under the last line of every chunk and has the host fill it for that chunk', function () {
    const host = new RecordingHost()
    const view = mount(host, new Compartment(), suggestions())

    const blocks = [...view.dom.querySelectorAll('.cm-collaborationControl-review-chunk')]
    assert.deepEqual(blocks.map(block => block.textContent), ['chunk:chunk-alpha', 'chunk:chunk-bravo'])
    assert.deepEqual(blocks.map(block => lineAbove(view, block)), ['alpha proposed', 'bravo proposed second half'],
      'a chunk spanning two lines gets its block after the second')
    const bar = view.dom.querySelector('.cm-panels-bottom .cm-collaborationControl-review-bar')
    assert.equal(bar?.textContent, 'review-bar', 'the review bar sits at the editor\'s bottom edge')
  })

  it('locks the chunk blocks and the bar while the chunks are mapped through an edit the provider has not answered', function () {
    const host = new RecordingHost()
    const reviewCompartment = new Compartment()
    const view = mount(host, reviewCompartment, suggestions())
    const alphaBlock = view.dom.querySelector('.cm-collaborationControl-review-chunk')
    assert.ok(alphaBlock !== null)
    assert.equal(alphaBlock.hasAttribute('inert'), false, 'blocks built from a broadcast take input')

    const charlie = WORKING.indexOf('charlie')
    view.dispatch({ changes: { from: charlie, insert: 'x' } })

    const locked = [...view.dom.querySelectorAll('.cm-collaborationControl-review-chunk, .cm-collaborationControl-review-bar')]
    assert.equal(locked.length, 3)
    assert.ok(locked.every(block => block.hasAttribute('inert')), 'every review control is inert after a local edit')
    assert.equal(view.dom.querySelector('.cm-collaborationControl-review-chunk'), alphaBlock,
      'locking keeps the host content in place instead of re-creating the block')
    assert.deepEqual(host.unmounted, [], 'nothing is handed back while only the lock changes')

    // The provider's broadcast for the edited text arrives: the chunks are
    // rebuilt from it, and the controls take input again.
    view.dispatch({ effects: reviewCompartment.reconfigure(reviewChunksExtension({ suggestions: suggestions() })) })
    const unlocked = [...view.dom.querySelectorAll('.cm-collaborationControl-review-chunk, .cm-collaborationControl-review-bar')]
    assert.ok(unlocked.every(block => !block.hasAttribute('inert')))
  })

  it('opens the active annotation\'s thread under the last line its target covers, and hands it back when closed', function () {
    const host = new RecordingHost()
    const view = mount(host, new Compartment(), [])
    const target = { from: WORKING.indexOf('first half'), to: span('bravo proposed second').to }
    view.dispatch({ effects: setAnnotationSessionEffect.of({ generation: 1, items: [annotation('annotation-bravo', target.from, target.to)] }) })
    assert.equal(view.dom.querySelectorAll('.cm-collaborationControl-annotation-thread').length, 0,
      'an annotation nobody opened shows its chip, not its thread')

    view.dispatch({ effects: setActiveAnnotationEffect.of('annotation-bravo') })
    const threads = [...view.dom.querySelectorAll('.cm-collaborationControl-annotation-thread')]
    assert.deepEqual(threads.map(thread => thread.textContent), ['thread:annotation-bravo'])
    assert.equal(lineAbove(view, threads[0]), 'bravo proposed second half')

    view.dispatch({ effects: setActiveAnnotationEffect.of(null) })
    assert.equal(view.dom.querySelectorAll('.cm-collaborationControl-annotation-thread').length, 0)
    assert.deepEqual(host.unmounted, ['thread:annotation-bravo'])
  })

  it('keeps a resolved annotation\'s thread closed while resolved annotations are hidden', function () {
    const host = new RecordingHost()
    const view = mount(host, new Compartment(), [])
    const target = span('alpha proposed')
    view.dispatch({
      effects: [
        setAnnotationSessionEffect.of({ generation: 1, items: [annotation('annotation-alpha', target.from, target.to, 'resolved')] }),
        setActiveAnnotationEffect.of('annotation-alpha')
      ]
    })
    assert.equal(view.dom.querySelectorAll('.cm-collaborationControl-annotation-thread').length, 0)
  })

  it('takes the chunk blocks and the bar away once no chunk is outstanding', function () {
    const host = new RecordingHost()
    const reviewCompartment = new Compartment()
    const view = mount(host, reviewCompartment, suggestions())

    view.dispatch({ effects: reviewCompartment.reconfigure(reviewChunksExtension({ suggestions: [] })) })

    assert.equal(view.dom.querySelectorAll('.cm-collaborationControl').length, 0)
    assert.deepEqual([...host.unmounted].sort(), ['chunk:chunk-alpha', 'chunk:chunk-bravo', 'review-bar'])
  })
})

/**
 * Mounts the production AnnotationsTab.vue against the same fixture session
 * the unit spec uses (annotations-sidebar-scene-fixture.ts), for the M7
 * structural-conformance captures (plan section 4, scenes 03/05/10/11). The
 * harness computes no render output itself — every card, pill, and count on
 * screen is the real component reading a real Pinia store, exactly the path
 * the app takes, with only the IPC transport stubbed to serve the fixture.
 */

// Must be the first local import: it installs window.ipc as a side effect,
// before the Pinia stores below (imported transitively through
// AnnotationsTab) read window.ipc at their own module top level.
import { recordedRequests, setAnnotationsSceneSession } from './annotations-sidebar-visual-ipc-stub'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import loadIcons from 'source/common/modules/window-register/load-icons'
import AnnotationsTab from 'source/win-main/sidebar/AnnotationsTab.vue'
import { useDocumentCollaborationStore, useDocumentTreeStore } from 'source/pinia'
import { buildSceneSession, buildSceneSessionWithReview, SCENE_DOCUMENT_PATH } from './annotations-sidebar-scene-fixture'

declare global {
  interface Window {
    captureReady: Promise<void>
    annotationsSceneSelect: (annotationId: string | null) => Promise<void>
    annotationsSceneSetShowResolved: (value: boolean) => Promise<void>
    /** Swap the cached session for the one that also carries a review, so
     *  the SuggestionInspector mounts (M9). */
    annotationsSceneSetReview: (active: boolean) => Promise<void>
    /** Click the nth Accept control the panel renders, and report the
     *  request that reached the preload bridge because of it. */
    annotationsSceneAcceptChunk: (index: number) => Promise<{ channel: string, message: unknown } | undefined>
    /** Type into the nth chunk's note field and blur it, reporting the
     *  request the commit raised. */
    annotationsSceneWriteChunkNote: (index: number, text: string) => Promise<{ channel: string, message: unknown } | undefined>
    /** Type a review-level comment and submit it, reporting the request. */
    annotationsSceneWriteReviewComment: (text: string) => Promise<{ channel: string, message: unknown } | undefined>
    /**
     * Type into the nth chunk's note field WITHOUT committing, then let the
     * provider's echo of an earlier commit land. Reports whether the field
     * kept the unsent characters and the caret.
     */
    annotationsSceneTypeThroughEcho: (index: number, text: string) => Promise<{ value: string, focused: boolean }>
    annotationsSceneDiagnostics: () => {
      openCount: number
      listCardCount: number
      resolvedDisclosurePresent: boolean
      inspectorPresent: boolean
      inspectorMode: string
      suggestionInspectorPresent: boolean
      suggestionChunkCount: number
      outstandingLabel: string
      acceptCount: number
      rejectCount: number
      chunkNoteValues: string[]
      massActionCount: number
      reviewCommentPresent: boolean
    }
  }
}

const sceneSession = buildSceneSession()
const reviewedSession = buildSceneSessionWithReview()
setAnnotationsSceneSession(sceneSession)

async function mount (): Promise<void> {
  await loadIcons()

  const app = createApp(AnnotationsTab)
  app.use(createPinia())

  const documentTreeStore = useDocumentTreeStore()
  documentTreeStore.lastLeafActiveFile = { path: SCENE_DOCUMENT_PATH, pinned: false }

  const collaborationStore = useDocumentCollaborationStore()

  const host = document.querySelector<HTMLElement>('#app')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }
  app.mount(host)

  await collaborationStore.ensureSession(SCENE_DOCUMENT_PATH)
  await nextTick()

  window.annotationsSceneSelect = async (annotationId) => {
    collaborationStore.selectAnnotation(annotationId)
    await nextTick()
  }
  window.annotationsSceneSetShowResolved = async (value) => {
    collaborationStore.toggleShowResolved(value)
    await nextTick()
  }
  // The broadcast handler's own effect on the cache, without a broadcast to
  // wait for: the panel reads the same session object either way.
  window.annotationsSceneSetReview = async (active) => {
    collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH] = active ? reviewedSession : sceneSession
    await nextTick()
  }
  /** Runs an interaction and reports the request it put on the bridge. */
  async function requestRaisedBy (interact: () => void): Promise<{ channel: string, message: unknown } | undefined> {
    const before = recordedRequests().length
    interact()
    await nextTick()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await nextTick()
    return recordedRequests().slice(before)[0]
  }

  function noteFieldAt (index: number): HTMLInputElement {
    const input = document.querySelectorAll<HTMLInputElement>('input.suggestion-chunk-comment')[index]
    if (input === undefined) {
      throw new Error(`the panel renders no note field at index ${index}`)
    }
    return input
  }

  /** Types into a real field the way a reviewer does, through v-model. */
  function typeInto (input: HTMLInputElement, text: string): void {
    input.focus()
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  window.annotationsSceneAcceptChunk = async (index) => {
    return await requestRaisedBy(() => {
      document.querySelectorAll<HTMLButtonElement>('.suggestion-decision.accept')[index]?.click()
    })
  }
  window.annotationsSceneWriteChunkNote = async (index, text) => {
    const input = noteFieldAt(index)
    typeInto(input, text)
    await nextTick()
    return await requestRaisedBy(() => { input.dispatchEvent(new FocusEvent('blur')) })
  }
  window.annotationsSceneWriteReviewComment = async (text) => {
    const input = document.querySelector<HTMLInputElement>('input.suggestion-review-comment-input')
    if (input === null) {
      throw new Error('the panel renders no review comment field')
    }
    typeInto(input, text)
    await nextTick()
    return await requestRaisedBy(() => {
      document.querySelector<HTMLButtonElement>('.suggestion-review-comment-submit')?.click()
    })
  }
  window.annotationsSceneTypeThroughEcho = async (index, text) => {
    const input = noteFieldAt(index)
    typeInto(input, text)
    await nextTick()
    // The broadcast a commit provokes, carrying the provider's own note for
    // this chunk. It re-renders the inspector while the reviewer is still in
    // the field with characters they have not sent.
    collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH] = {
      ...reviewedSession,
      review: {
        ...reviewedSession.review!,
        reviewGeneration: reviewedSession.review!.reviewGeneration + 1,
        chunkComments: reviewedSession.review!.suggestions.map(suggestion => ({
          chunkId: suggestion.suggestionId,
          comment: 'the provider\'s own note'
        }))
      }
    }
    await nextTick()
    const after = noteFieldAt(index)
    return { value: after.value, focused: document.activeElement === after }
  }
  window.annotationsSceneDiagnostics = () => ({
    openCount: sceneSession.annotations.items.filter(a => a.state === 'open').length,
    listCardCount: document.querySelectorAll('.annotation-list-item').length,
    resolvedDisclosurePresent: document.querySelector('.annotation-resolved-disclosure') !== null,
    inspectorPresent: document.querySelector('.annotation-inspector') !== null,
    inspectorMode: document.querySelector('.annotations-tab')?.getAttribute('data-inspector-mode') ?? '',
    suggestionInspectorPresent: document.querySelector('.suggestion-inspector') !== null,
    suggestionChunkCount: document.querySelectorAll('.suggestion-chunk').length,
    outstandingLabel: document.querySelector('.suggestion-outstanding')?.textContent ?? '',
    acceptCount: document.querySelectorAll('.suggestion-decision.accept').length,
    rejectCount: document.querySelectorAll('.suggestion-decision.reject').length,
    chunkNoteValues: [...document.querySelectorAll<HTMLInputElement>('input.suggestion-chunk-comment')].map(input => input.value),
    massActionCount: document.querySelectorAll('.suggestion-inspector-mass-actions button').length,
    reviewCommentPresent: document.querySelector('.suggestion-review-comment-submit') !== null,
  })

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()

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
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { defaultDark, editorTheme } from '@common/modules/markdown-editor/theme/editor'
import {
  setActiveAnnotationEffect,
  setAnnotationDraftEffect,
  setAnnotationSessionEffect,
  showResolvedAnnotationsEffect,
  textAnnotationsExtension
} from '@common/modules/markdown-editor/plugins/text-annotations'
import loadIcons from 'source/common/modules/window-register/load-icons'
import AnnotationsTab from 'source/win-main/sidebar/AnnotationsTab.vue'
import MainSidebar from 'source/win-main/sidebar/MainSidebar.vue'
import { useDocumentCollaborationStore, useDocumentTreeStore } from 'source/pinia'
import type { AnnotationSet, TextAnnotation } from '@dts/common/annotation-domain'
import {
  buildSceneSession,
  buildSceneSessionForM10Captures,
  buildSceneSessionWithOrphan,
  buildSceneSessionWithReview,
  SCENE_DOCUMENT_PATH
} from './annotations-sidebar-scene-fixture'

declare global {
  interface Window {
    captureReady: Promise<void>
    annotationsSceneSelect: (annotationId: string | null) => Promise<void>
    annotationsSceneSetShowResolved: (value: boolean) => Promise<void>
    /** Swap the cached session for the one that also carries a review, so
     *  the SuggestionInspector mounts (M9). */
    annotationsSceneSetReview: (active: boolean) => Promise<void>
    /** Swap the cached session for the one carrying a fourth, orphaned
     *  annotation (M10, S8/I6) — the only state that renders a real
     *  Reattach control. */
    annotationsSceneSetOrphanScenario: (active: boolean) => Promise<void>
    /** Swap the cached session for the one M10's own capture scenes need
     *  (04 multi-turn/no-proposal, 06 partial proposal): the base three
     *  annotations plus a multi-turn thread and a partially-decided
     *  proposal, review active. */
    annotationsSceneSetM10CapturesScenario: (active: boolean) => Promise<void>
    /** Structural diagnostics for the composite editor mount scene 12 uses
     *  (every distinguishable state from plan section 3, dark theme). */
    annotationsSceneEditorDiagnostics: () => {
      marks: number
      markers: number
      activeMarks: number
      resolvedMarks: number
      orphanedMarkers: number
      pointMarkers: number
      overlappingMarkers: number
      draftMarks: number
      contentClientWidth: number | undefined
      contentScrollWidth: number | undefined
    }
    /**
     * Clicks the selected card's "Show proposal" action (S7) and reports
     * which outstanding suggestion chunk ids the panel marked focused —
     * read from the SAME session's linked proposalActions, not asserted by
     * the driver, so this can only pass if the panel actually resolved the
     * link itself.
     */
    annotationsSceneClickShowProposal: () => Promise<string[]>
    /**
     * Clicks "Reattach" on the selected card inside the OFF-SCREEN, REAL
     * MainSidebar.vue mount (not the standalone panel) and reports every
     * annotation id MainSidebar's own begin-reattach listener has received
     * so far — the exact boundary this milestone wires (AnnotationsTab's
     * emit used to die at MainSidebar, which forwarded only jump-to-line).
     */
    annotationsSceneClickReattachInSidebar: () => Promise<string[]>
    /**
     * The rendered text of the annotations tab's TabBar badge, from a REAL
     * mounted MainSidebar.vue sharing the same Pinia session as the panel
     * above — the boundary proof that MainSidebar's own wiring (not just
     * openAnnotationCount() in isolation) puts the open-only count on
     * screen. Null if MainSidebar renders no badge at all.
     */
    annotationsSceneMainSidebarBadge: () => string | null
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
      /** Suggestion chunk ids currently marked linked (S7 "Show proposal"). */
      linkedProposalChunkIds: string[]
    }
  }
}

const sceneSession = buildSceneSession()
const reviewedSession = buildSceneSessionWithReview()
const orphanSession = buildSceneSessionWithOrphan()
const m10CapturesSession = buildSceneSessionForM10Captures()
setAnnotationsSceneSession(sceneSession)

/**
 * A small, self-contained document carrying every distinguishable editor
 * state from plan section 3, for scene 12 (12-dark-mode-complete) — the ONE
 * scene that needs "every surface" (not just the panel) on screen at once.
 * Reuses the SAME webpack bundle as the panel above (it already resolves
 * @codemirror/*, per test/annotations-sidebar-visual-build.cjs), so this
 * needs no second build pipeline (M10's own instruction: follow the
 * existing registry conventions rather than inventing a parallel one).
 */
const EDITOR_STATES_DOC = [
  '# Every Distinguishable Annotation State',                                     // 1 (orphaned marker always lands here)
  '',                                                                             // 2
  'An inactive marker sits quietly over ordinary open prose right here.',         // 3
  'An active marker gets the stronger treatment once its own card is open.',      // 4
  'Two spans on this single line overlap into one grouped marker badge here.',    // 5
  'A point target appears once its exact text is deleted from the document.',     // 6
  'A drafting selection shows a transient underline before it is ever saved.',    // 7
  'A resolved annotation stays invisible unless View resolved is toggled on.'     // 8
].join('\n')

function editorStateSpan (needle: string): { from: number, to: number } {
  const from = EDITOR_STATES_DOC.indexOf(needle)
  if (from < 0) {
    throw new Error(`Scene 12 fixture text does not contain: ${needle}`)
  }
  return { from, to: from + needle.length }
}

let editorStateIdCounter = 0
function editorStateAnnotation (anchor: TextAnnotation['anchor'], state: TextAnnotation['state'] = 'open'): TextAnnotation {
  editorStateIdCounter += 1
  return {
    annotationId: `editor-state-${editorStateIdCounter}`,
    documentId: 'scene-12-editor-states',
    anchor,
    state,
    messages: [{ messageId: `editor-state-msg-${editorStateIdCounter}`, author: 'owner', text: 'Scene 12 fixture.', createdAt: '2026-01-01T00:00:00.000Z' }],
    proposalActions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

const inactiveSpan = editorStateSpan('inactive marker sits quietly over ordinary open prose right here')
const activeSpan = editorStateSpan('active marker gets the stronger treatment once its own card is open')
const overlapSpanA = editorStateSpan('Two spans on this single line')
const overlapSpanB = editorStateSpan('overlap into one grouped marker badge here')
const deletionSeam = editorStateSpan('point target appears once its exact text is deleted').from
const draftSpan = editorStateSpan('drafting selection shows a transient underline')
const resolvedSpan = editorStateSpan('resolved annotation stays invisible unless View resolved is toggled on')

const activeAnnotation = editorStateAnnotation({ state: 'range', ...activeSpan, quotedText: EDITOR_STATES_DOC.slice(activeSpan.from, activeSpan.to) })

const EDITOR_STATES_SET: AnnotationSet = {
  generation: 1,
  items: [
    editorStateAnnotation({ state: 'range', ...inactiveSpan, quotedText: EDITOR_STATES_DOC.slice(inactiveSpan.from, inactiveSpan.to) }),
    activeAnnotation,
    editorStateAnnotation({ state: 'range', ...overlapSpanA, quotedText: EDITOR_STATES_DOC.slice(overlapSpanA.from, overlapSpanA.to) }),
    editorStateAnnotation({ state: 'range', ...overlapSpanB, quotedText: EDITOR_STATES_DOC.slice(overlapSpanB.from, overlapSpanB.to) }),
    editorStateAnnotation({ state: 'point', at: deletionSeam, quotedText: 'its exact text', reason: 'target-deleted' }),
    editorStateAnnotation({ state: 'orphaned', quotedText: 'a passage the owner commented on', reason: 'external-drift' }),
    editorStateAnnotation({ state: 'range', ...resolvedSpan, quotedText: EDITOR_STATES_DOC.slice(resolvedSpan.from, resolvedSpan.to) }, 'resolved')
  ]
}

async function mount (): Promise<void> {
  await loadIcons()

  const app = createApp(AnnotationsTab)
  // One shared Pinia instance for both apps below: MainSidebar's own tab
  // badge must read the SAME collaboration session and active file the
  // panel does, not a second independent copy.
  const pinia = createPinia()

  app.use(pinia)

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

  // A second, off-screen mount of the real MainSidebar.vue — the S10
  // boundary proof needs the REAL tab-badge wiring rendered, not just the
  // pure counting function it reads from. Wrapped in a plain render-function
  // parent (App.vue's actual role) so this harness can observe what
  // MainSidebar itself emits upward, the same way App.vue does — the M10
  // boundary proof needs the REAL forwarding wired, not just the emit
  // AnnotationsTab raises into MainSidebar's absence of a listener.
  const sidebarHost = document.createElement('div')
  sidebarHost.style.position = 'absolute'
  sidebarHost.style.left = '-9999px'
  document.body.appendChild(sidebarHost)
  const beginReattachEvents: string[] = []
  const sidebarApp = createApp({
    render: () => h(MainSidebar, {
      onBeginReattach: (annotationId: string) => { beginReattachEvents.push(annotationId) }
    })
  })
  sidebarApp.use(pinia)
  sidebarApp.mount(sidebarHost)
  await nextTick()

  window.annotationsSceneMainSidebarBadge = () => {
    return sidebarHost.querySelector('.system-tab[data-target="annotations-panel"] .system-tab-badge')?.textContent ?? null
  }

  // The composite editor for scene 12 (12-dark-mode-complete): a bare
  // EditorView, always built with the dark theme (this scene has no light
  // variant), carrying every distinguishable state plan section 3 names.
  // Lives beside #app in the page the driver builds, so one screenshot
  // shows both the editor's locators and the panel together (S1).
  const editorHost = document.querySelector<HTMLElement>('#editor-complete')
  if (editorHost !== null) {
    const editorView = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: EDITOR_STATES_DOC,
        extensions: [editorTheme, defaultDark, EditorView.lineWrapping, lineNumbers(), textAnnotationsExtension()]
      })
    })
    editorView.dispatch({
      effects: [
        setAnnotationSessionEffect.of(EDITOR_STATES_SET),
        setActiveAnnotationEffect.of(activeAnnotation.annotationId),
        setAnnotationDraftEffect.of(draftSpan),
        showResolvedAnnotationsEffect.of(true)
      ]
    })

    window.annotationsSceneEditorDiagnostics = () => {
      const content = editorHost.querySelector<HTMLElement>('.cm-content')
      return {
        marks: editorHost.querySelectorAll('.cm-textAnnotation-mark').length,
        markers: editorHost.querySelectorAll('.cm-textAnnotation-gutterMarker').length,
        activeMarks: editorHost.querySelectorAll('.cm-textAnnotation-mark-active').length,
        resolvedMarks: editorHost.querySelectorAll('.cm-textAnnotation-mark-resolved').length,
        orphanedMarkers: editorHost.querySelectorAll('.cm-textAnnotation-gutterMarker-orphaned').length,
        pointMarkers: editorHost.querySelectorAll('.cm-textAnnotation-gutterMarker-point').length,
        overlappingMarkers: editorHost.querySelectorAll('.cm-textAnnotation-gutterMarker-overlapping').length,
        draftMarks: editorHost.querySelectorAll('.cm-textAnnotation-draft').length,
        contentClientWidth: content?.clientWidth,
        contentScrollWidth: content?.scrollWidth
      }
    }
  }

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
  window.annotationsSceneSetOrphanScenario = async (active) => {
    collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH] = active ? orphanSession : sceneSession
    await nextTick()
  }
  window.annotationsSceneSetM10CapturesScenario = async (active) => {
    collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH] = active ? m10CapturesSession : sceneSession
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

  // An arrow const, not a function declaration: declarations hoist, so TypeScript
  // will not carry `host`'s null check into one, and this reads the panel mount.
  const noteFieldAt = (index: number): HTMLInputElement => {
    const input = host.querySelectorAll<HTMLInputElement>('input.suggestion-chunk-comment')[index]
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
      host.querySelectorAll<HTMLButtonElement>('.suggestion-decision.accept')[index]?.click()
    })
  }
  window.annotationsSceneWriteChunkNote = async (index, text) => {
    const input = noteFieldAt(index)
    typeInto(input, text)
    await nextTick()
    return await requestRaisedBy(() => { input.dispatchEvent(new FocusEvent('blur')) })
  }
  window.annotationsSceneWriteReviewComment = async (text) => {
    const input = host.querySelector<HTMLInputElement>('input.suggestion-review-comment-input')
    if (input === null) {
      throw new Error('the panel renders no review comment field')
    }
    typeInto(input, text)
    await nextTick()
    return await requestRaisedBy(() => {
      host.querySelector<HTMLButtonElement>('.suggestion-review-comment-submit')?.click()
    })
  }
  window.annotationsSceneClickShowProposal = async () => {
    host.querySelector<HTMLButtonElement>('.annotation-action-show-proposal')?.click()
    await nextTick()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await nextTick()
    return [...host.querySelectorAll('.suggestion-chunk.suggestion-chunk-linked')]
      .map(el => el.getAttribute('data-chunk-id') ?? '')
  }
  window.annotationsSceneClickReattachInSidebar = async () => {
    sidebarHost.querySelector<HTMLButtonElement>('.annotation-action-reattach')?.click()
    await nextTick()
    return [...beginReattachEvents]
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
  // Scoped to `host` (the standalone panel mount), not `document`: the
  // off-screen MainSidebar mount above renders its OWN nested AnnotationsTab
  // instance (same shared session), and an unscoped query would count both
  // mounts' cards, chunks and controls.
  window.annotationsSceneDiagnostics = () => ({
    openCount: sceneSession.annotations.items.filter(a => a.state === 'open').length,
    listCardCount: host.querySelectorAll('.annotation-list-item').length,
    resolvedDisclosurePresent: host.querySelector('.annotation-resolved-disclosure') !== null,
    inspectorPresent: host.querySelector('.annotation-inspector') !== null,
    inspectorMode: host.querySelector('.annotations-tab')?.getAttribute('data-inspector-mode') ?? '',
    suggestionInspectorPresent: host.querySelector('.suggestion-inspector') !== null,
    suggestionChunkCount: host.querySelectorAll('.suggestion-chunk').length,
    outstandingLabel: host.querySelector('.suggestion-outstanding')?.textContent ?? '',
    acceptCount: host.querySelectorAll('.suggestion-decision.accept').length,
    rejectCount: host.querySelectorAll('.suggestion-decision.reject').length,
    chunkNoteValues: [...host.querySelectorAll<HTMLInputElement>('input.suggestion-chunk-comment')].map(input => input.value),
    massActionCount: host.querySelectorAll('.suggestion-inspector-mass-actions button').length,
    reviewCommentPresent: host.querySelector('.suggestion-review-comment-submit') !== null,
    linkedProposalChunkIds: [...host.querySelectorAll('.suggestion-chunk.suggestion-chunk-linked')]
      .map(el => el.getAttribute('data-chunk-id') ?? ''),
  })

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()

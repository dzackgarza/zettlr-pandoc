/**
 * Mounts the production collaboration surfaces against the same fixture
 * session the unit spec uses (annotations-sidebar-scene-fixture.ts), for the
 * plan's capture scenes 03/04/05/06/10/11/12 and the review controls:
 *
 * - AnnotationsTab.vue, the workspace list in the right-hand panel;
 * - a CodeMirror pane over the scene document carrying the production
 *   review-chunks, text-annotations and collaboration-controls extensions,
 *   filled by InlineCollaborationControls.vue exactly as MainEditor fills
 *   them: the controls under each review chunk, the review bar, and the
 *   open annotation's thread under its target.
 *
 * The harness computes no render output itself. Every row, thread, control
 * and count on screen is a real component reading a real Pinia store; only
 * the IPC transport is stubbed to serve the fixture, and the wrapper below
 * plays the two roles the app gives App.vue and MainEditor.vue (routing the
 * panel's navigation to the selection, and syncing the pane from the store).
 */

// Must be the first local import: it installs window.ipc as a side effect,
// before the Pinia stores below (imported transitively through
// AnnotationsTab) read window.ipc at their own module top level.
import './document-collaboration-ipc-double'
import { documentCollaborationIpcDouble } from './document-collaboration-ipc-double'
import { recordedRequests, setAnnotationsSceneSession } from './annotations-sidebar-visual-ipc-stub'
import { createApp, h, nextTick, shallowRef, watch } from 'vue'
import { createPinia } from 'pinia'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { defaultDark, defaultLight, editorTheme } from '@common/modules/markdown-editor/theme/editor'
import { reviewChunksExtension } from '@common/modules/markdown-editor/plugins/review-chunks'
import {
  annotationChipClickedEffect,
  setActiveAnnotationEffect,
  setAnnotationDraftEffect,
  setAnnotationSessionEffect,
  showResolvedAnnotationsEffect,
  textAnnotationsExtension
} from '@common/modules/markdown-editor/plugins/text-annotations'
import {
  collaborationControls,
  type CollaborationControl
} from '@common/modules/markdown-editor/plugins/collaboration-controls'
import loadIcons from 'source/common/modules/window-register/load-icons'
import AnnotationsTab from 'source/win-main/sidebar/AnnotationsTab.vue'
import ActivityBar from 'source/win-main/sidebar/ActivityBar.vue'
import InlineCollaborationControls, { type CollaborationBlock } from 'source/win-main/editor-collaboration/InlineCollaborationControls.vue'
import { PANEL_VIEW_ID, PANEL_VIEWS } from 'source/win-main/sidebar/sidebar-views'
import { useDocumentCollaborationStore, useDocumentTreeStore } from 'source/pinia'
import type { AnnotationSet, TextAnnotation } from '@dts/common/annotation-domain'
import type { SourceRange } from '@dts/common/references'
import {
  buildSceneSession,
  buildSceneSessionForM10Captures,
  buildSceneSessionWithOrphan,
  buildSceneSessionWithReview,
  SCENE_DOCUMENT_PATH,
  SCENE_WORKING_TEXT
} from './annotations-sidebar-scene-fixture'

/** A request the page put on the preload bridge. */
interface RaisedRequest { channel: string, message: unknown }

declare global {
  interface Window {
    captureReady: Promise<void>
    /** The fixture document the pane shows, for offsets the driver checks. */
    annotationsSceneWorkingText: string
    annotationsSceneSelect: (annotationId: string | null) => Promise<void>
    annotationsSceneSetShowResolved: (value: boolean) => Promise<void>
    /** Swap the cached session for the one that also carries a review, so
     *  the pane places chunk controls and the review bar. */
    annotationsSceneSetReview: (active: boolean) => Promise<void>
    /** Swap the cached session for the one carrying a fourth, orphaned
     *  annotation (S8/I6) — the only state whose thread offers Reattach. */
    annotationsSceneSetOrphanScenario: (active: boolean) => Promise<void>
    /** Swap the cached session for the one scenes 04 and 06 need: the base
     *  three annotations plus a multi-turn thread and a partially decided
     *  proposal, review active. */
    annotationsSceneSetM10CapturesScenario: (active: boolean) => Promise<void>
    /** Clicks the gutter chip on a 1-based source line, as the owner does. */
    annotationsSceneClickChip: (line: number) => Promise<void>
    /** Clicks an annotation's row in the workspace panel and reports every
     *  navigation the panel raised so far. */
    annotationsSceneClickRow: (annotationId: string) => Promise<Array<{ documentPath: string, range?: SourceRange, annotationId?: string }>>
    /** Structural diagnostics for the composite editor scene 12 adds (every
     *  distinguishable locator state from plan section 3, dark theme). */
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
    /** Clicks the open thread's "Show diff" and reports the ranges the
     *  controls asked the pane to reveal so far. */
    annotationsSceneClickShowProposal: () => Promise<SourceRange[]>
    /** Clicks the open thread's Reattach and reports every annotation id the
     *  controls handed the pane so far — only the id crosses (S8/I6). */
    annotationsSceneClickReattach: () => Promise<string[]>
    /** Clicks the panel header's close and reports how many times the
     *  panel's parent (App.vue's role, which hides the pane) was asked. */
    annotationsSceneClickClose: () => Promise<number>
    /** Types a reply into the open thread's composer and presses Mod-Enter,
     *  reporting the request the store raised because of it. */
    annotationsSceneComposeReply: (text: string) => Promise<RaisedRequest | undefined>
    /** Types a draft into the thread's composer and presses Escape,
     *  reporting what the field holds afterwards. */
    annotationsSceneComposeEscape: (text: string) => Promise<string>
    /** Clicks the nth chunk's Accept in the pane, reporting the request. */
    annotationsSceneAcceptChunk: (index: number) => Promise<RaisedRequest | undefined>
    /** Types into the nth chunk's note field and blurs it, reporting the
     *  request the commit raised. */
    annotationsSceneWriteChunkNote: (index: number, text: string) => Promise<RaisedRequest | undefined>
    /** Types a review comment into the review bar and submits it. */
    annotationsSceneWriteReviewComment: (text: string) => Promise<RaisedRequest | undefined>
    /** Types into the nth chunk's note field WITHOUT committing, then lets
     *  the provider's echo of an earlier commit land. Reports whether the
     *  field kept the unsent characters and the caret. */
    annotationsSceneTypeThroughEcho: (index: number, text: string) => Promise<{ value: string, focused: boolean }>
    annotationsSceneDiagnostics: () => {
      /** Open annotation rows in the workspace panel. */
      annotationRowCount: number
      /** Outstanding-change rows in the workspace panel. */
      suggestionRowCount: number
      documentAcceptAllCount: number
      globalAcceptAllPresent: boolean
      /** Heading elements inside the panel: the header is a body-size row. */
      headingCount: number
      /** The panel toggle's shortcut, as the header's chip renders it. */
      shortcutChip: string
      /** The annotation ids whose thread is open in the pane. */
      threadIds: string[]
      threadLifecycle: string
      /** The composer is mounted with the thread, not behind a Reply click. */
      composerPresent: boolean
      /** Resolve (or Reopen) renders exactly once, in the thread. */
      resolveCount: number
      resolveLabel: string
      reattachPresent: boolean
      /** The proposal card's one affordance. */
      showProposalLabel: string
      proposalCardText: string | null
      /** Every thread message's relative time, in thread order. */
      messageTimes: string[]
      /** Chunk control blocks in the pane, and what they carry. */
      chunkControlCount: number
      acceptCount: number
      rejectCount: number
      chunkNoteValues: string[]
      reviewBarPresent: boolean
      reviewBarLabel: string
      reviewBarMassActionCount: number
      reviewCommentPresent: boolean
    }
    annotationsSceneActivityBadgeDiagnostics: () => {
      text: string
      ariaLabel: string|null
      unresolvedCount: string|undefined
    }
  }
}

const sceneSession = buildSceneSession()
const reviewedSession = buildSceneSessionWithReview()
const orphanSession = buildSceneSessionWithOrphan()
const m10CapturesSession = buildSceneSessionForM10Captures()
setAnnotationsSceneSession(sceneSession)

/**
 * A small, self-contained document carrying every distinguishable locator
 * state from plan section 3, for scene 12 (12-dark-mode-complete), which
 * shows every surface at once.
 */
const EDITOR_STATES_DOC = [
  '# Every Distinguishable Annotation State',                                     // 1 (orphaned marker always lands here)
  '',                                                                             // 2
  'An inactive marker sits quietly over ordinary open prose right here.',         // 3
  'An active marker gets the stronger treatment once its own thread is open.',    // 4
  'Two spans on this single line overlap into one grouped marker badge here.',    // 5
  'A point target appears once its exact text is deleted from the document.',     // 6
  'A drafting selection shows a transient underline before it is ever saved.',    // 7
  'A resolved annotation stays invisible unless resolved ones are shown.'         // 8
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
const activeSpan = editorStateSpan('active marker gets the stronger treatment once its own thread is open')
const overlapSpanA = editorStateSpan('Two spans on this single line')
const overlapSpanB = editorStateSpan('overlap into one grouped marker badge here')
const deletionSeam = editorStateSpan('point target appears once its exact text is deleted').from
const draftSpan = editorStateSpan('drafting selection shows a transient underline')
const resolvedSpan = editorStateSpan('resolved annotation stays invisible unless resolved ones are shown')

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

function requireElement<T extends Element> (root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (element === null) {
    throw new Error(`the scene renders no ${selector}`)
  }
  return element
}

async function settle (): Promise<void> {
  await nextTick()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mount (): Promise<void> {
  await loadIcons()
  const dark = document.body.classList.contains('dark')
  const panelHost = requireElement<HTMLElement>(document, '#app')
  const paneHost = requireElement<HTMLElement>(document, '#editor')

  const pinia = createPinia()
  const navigationEvents: Array<{ documentPath: string, range?: SourceRange, annotationId?: string }> = []
  const revealedRanges: SourceRange[] = []
  const reattachedIds: string[] = []
  let closeEvents = 0

  // The blocks the pane's editor places, exactly as MainEditor keeps them.
  const blocks = shallowRef<CollaborationBlock[]>([])
  let blockSerial = 0
  const mountCollaborationControl = (dom: HTMLElement, control: CollaborationControl): (() => void) => {
    const block: CollaborationBlock = { key: ++blockSerial, dom, control }
    blocks.value = [...blocks.value, block]
    return () => { blocks.value = blocks.value.filter(existing => existing !== block) }
  }

  const app = createApp({
    render: () => [
      h(AnnotationsTab, {
        workspacePaths: [SCENE_DOCUMENT_PATH],
        // App.vue's role: a row opens its document and, for an annotation,
        // that annotation's thread.
        onNavigate: (target: { documentPath: string, range?: SourceRange, annotationId?: string }) => {
          navigationEvents.push(target)
          if (target.annotationId !== undefined) {
            useDocumentCollaborationStore().selectAnnotation(target.annotationId)
          }
        },
        onClose: () => { closeEvents += 1 }
      }),
      h(InlineCollaborationControls, {
        documentPath: SCENE_DOCUMENT_PATH,
        blocks: blocks.value,
        onRevealRange: (range: SourceRange) => { revealedRanges.push(range) },
        onReattach: (annotationId: string) => { reattachedIds.push(annotationId) },
        onStepChunk: () => {}
      })
    ]
  })
  app.use(pinia)

  // Mount the production activity-bar component offscreen, so the panel's
  // captures stay unchanged while this real-SFC harness proves the
  // unresolved-work indicator.
  const activityHost = document.createElement('div')
  activityHost.style.position = 'fixed'
  activityHost.style.left = '-10000px'
  activityHost.style.top = '0'
  document.body.appendChild(activityHost)
  const activityApp = createApp({
    render: () => h(ActivityBar, {
      barId: 'scene-panel-activity-bar',
      side: 'right',
      items: PANEL_VIEWS,
      pressed: '',
      label: 'Panel views',
      badges: { [PANEL_VIEW_ID]: 4 },
      onPress: () => {}
    })
  })
  activityApp.mount(activityHost)

  const documentTreeStore = useDocumentTreeStore()
  documentTreeStore.lastLeafActiveFile = { path: SCENE_DOCUMENT_PATH, pinned: false }
  const collaborationStore = useDocumentCollaborationStore()

  window.annotationsSceneActivityBadgeDiagnostics = () => {
    const button = activityHost.querySelector<HTMLElement>(`[data-activity="${PANEL_VIEW_ID}"]`)
    const badge = activityHost.querySelector<HTMLElement>('.activity-bar-unresolved-badge')
    return {
      text: badge?.textContent?.trim() ?? '',
      ariaLabel: button?.getAttribute('aria-label') ?? null,
      unresolvedCount: button?.dataset.unresolvedCount
    }
  }

  // The pane over the scene document, carrying the extensions MarkdownEditor
  // installs for collaboration. A gutter chip toggles its thread, as
  // MainEditor does with the editor's annotation-selected event.
  const reviewCompartment = new Compartment()
  const pane = new EditorView({
    parent: paneHost,
    state: EditorState.create({
      doc: SCENE_WORKING_TEXT,
      extensions: [
        editorTheme,
        dark ? defaultDark : defaultLight,
        EditorView.lineWrapping,
        lineNumbers(),
        reviewCompartment.of([]),
        textAnnotationsExtension(),
        collaborationControls(mountCollaborationControl),
        EditorView.updateListener.of(update => {
          for (const transaction of update.transactions) {
            for (const effect of transaction.effects) {
              if (effect.is(annotationChipClickedEffect)) {
                collaborationStore.selectAnnotation(
                  collaborationStore.selectedAnnotationId === effect.value ? null : effect.value
                )
              }
            }
          }
        })
      ]
    })
  })

  app.mount(panelHost)

  // MainEditor's watchers: the store is the only thing that moves the pane.
  watch(() => collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH], session => {
    pane.dispatch({
      effects: [
        setAnnotationSessionEffect.of(session?.annotations ?? { generation: 0, items: [] }),
        reviewCompartment.reconfigure(session?.review === undefined
          ? []
          : reviewChunksExtension({ suggestions: session.review.suggestions }))
      ]
    })
  }, { immediate: true })
  watch(() => collaborationStore.selectedAnnotationId, annotationId => {
    pane.dispatch({ effects: setActiveAnnotationEffect.of(annotationId) })
  }, { immediate: true })
  watch(() => collaborationStore.showResolved, show => {
    pane.dispatch({ effects: showResolvedAnnotationsEffect.of(show) })
  }, { immediate: true })

  // The application menu, as the menu provider broadcasts it to a window
  // that asked for it: the header reads the panel toggle's shortcut chip
  // from this one item rather than from a copy of its own.
  documentCollaborationIpcDouble.emit('menu-provider', {
    command: 'application-menu',
    payload: [{
      type: 'submenu',
      label: 'View',
      enabled: true,
      submenu: [{
        type: 'normal',
        id: 'menu.toggle_annotation_panel',
        label: 'Toggle Annotation Panel',
        enabled: true,
        accelerator: 'Ctrl+Shift+0'
      }]
    }]
  })

  await collaborationStore.ensureSession(SCENE_DOCUMENT_PATH)
  await settle()

  // The composite locator editor for scene 12 (12-dark-mode-complete): a
  // bare EditorView carrying every distinguishable state plan section 3
  // names. It lives beside the pane and the panel, hidden until scene 12.
  const statesHost = document.querySelector<HTMLElement>('#editor-complete')
  if (statesHost !== null) {
    const statesView = new EditorView({
      parent: statesHost,
      state: EditorState.create({
        doc: EDITOR_STATES_DOC,
        extensions: [editorTheme, dark ? defaultDark : defaultLight, EditorView.lineWrapping, lineNumbers(), textAnnotationsExtension()]
      })
    })
    statesView.dispatch({
      effects: [
        setAnnotationSessionEffect.of(EDITOR_STATES_SET),
        setActiveAnnotationEffect.of(activeAnnotation.annotationId),
        setAnnotationDraftEffect.of(draftSpan),
        showResolvedAnnotationsEffect.of(true)
      ]
    })

    window.annotationsSceneEditorDiagnostics = () => {
      const content = statesHost.querySelector<HTMLElement>('.cm-content')
      return {
        marks: statesHost.querySelectorAll('.cm-textAnnotation-mark').length,
        markers: statesHost.querySelectorAll('.cm-textAnnotation-gutterMarker').length,
        activeMarks: statesHost.querySelectorAll('.cm-textAnnotation-mark-active').length,
        resolvedMarks: statesHost.querySelectorAll('.cm-textAnnotation-mark-resolved').length,
        orphanedMarkers: statesHost.querySelectorAll('.cm-textAnnotation-gutterMarker-orphaned').length,
        pointMarkers: statesHost.querySelectorAll('.cm-textAnnotation-gutterMarker-point').length,
        overlappingMarkers: statesHost.querySelectorAll('.cm-textAnnotation-gutterMarker-overlapping').length,
        draftMarks: statesHost.querySelectorAll('.cm-textAnnotation-draft').length,
        contentClientWidth: content?.clientWidth,
        contentScrollWidth: content?.scrollWidth
      }
    }
  }

  const setSession = async (session: typeof sceneSession): Promise<void> => {
    // The broadcast handler's own effect on the cache, without a broadcast
    // to wait for: the panel and the pane read the same session either way.
    collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH] = session
    await settle()
  }

  window.annotationsSceneSelect = async (annotationId) => {
    collaborationStore.selectAnnotation(annotationId)
    await settle()
  }
  window.annotationsSceneSetShowResolved = async (value) => {
    collaborationStore.toggleShowResolved(value)
    await settle()
  }
  window.annotationsSceneSetReview = async (active) => { await setSession(active ? reviewedSession : sceneSession) }
  window.annotationsSceneSetOrphanScenario = async (active) => { await setSession(active ? orphanSession : sceneSession) }
  window.annotationsSceneSetM10CapturesScenario = async (active) => { await setSession(active ? m10CapturesSession : sceneSession) }

  window.annotationsSceneClickChip = async (line) => {
    const marker = [...paneHost.querySelectorAll<HTMLElement>('.cm-textAnnotation-gutterMarker')]
      .find(candidate => candidate.dataset.line === String(line))
    if (marker === undefined) {
      throw new Error(`the pane carries no gutter chip on line ${line}`)
    }
    // The gutter resolves a press to its line by the pointer's height, so
    // the press lands on the chip itself.
    const box = marker.getBoundingClientRect()
    marker.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2
    }))
    await settle()
  }
  window.annotationsSceneClickRow = async (annotationId) => {
    requireElement<HTMLButtonElement>(panelHost, `.annotation-workspace-annotation[data-annotation-id="${annotationId}"]`).click()
    await settle()
    return navigationEvents
  }

  /** Runs an interaction and reports the request it put on the bridge. */
  async function requestRaisedBy (interact: () => void): Promise<RaisedRequest | undefined> {
    const before = recordedRequests().length
    interact()
    await settle()
    return recordedRequests().slice(before)[0]
  }

  const noteFieldAt = (index: number): HTMLInputElement => {
    const input = paneHost.querySelectorAll<HTMLInputElement>('input.suggestion-chunk-comment')[index]
    if (input === undefined) {
      throw new Error(`the pane renders no chunk note field at index ${index}`)
    }
    return input
  }

  /** Types into a real field the way a reviewer does, through v-model. */
  function typeInto (input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    input.focus()
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const composerField = (): HTMLTextAreaElement => requireElement<HTMLTextAreaElement>(paneHost, '[data-annotation-detail] .annotation-composer textarea')

  window.annotationsSceneClickClose = async () => {
    requireElement<HTMLButtonElement>(panelHost, '.annotation-header-close').click()
    await settle()
    return closeEvents
  }
  window.annotationsSceneComposeReply = async (text) => {
    const field = composerField()
    typeInto(field, text)
    await nextTick()
    return await requestRaisedBy(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    })
  }
  window.annotationsSceneComposeEscape = async (text) => {
    const field = composerField()
    typeInto(field, text)
    await nextTick()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    return field.value
  }
  window.annotationsSceneAcceptChunk = async (index) => {
    return await requestRaisedBy(() => {
      paneHost.querySelectorAll<HTMLButtonElement>('.suggestion-chunk .suggestion-decision.accept')[index]?.click()
    })
  }
  window.annotationsSceneWriteChunkNote = async (index, text) => {
    const input = noteFieldAt(index)
    typeInto(input, text)
    await nextTick()
    return await requestRaisedBy(() => { input.dispatchEvent(new FocusEvent('blur')) })
  }
  window.annotationsSceneWriteReviewComment = async (text) => {
    const input = requireElement<HTMLInputElement>(paneHost, '.suggestion-review-bar input.suggestion-review-comment-input')
    typeInto(input, text)
    await nextTick()
    return await requestRaisedBy(() => {
      requireElement<HTMLButtonElement>(paneHost, '.suggestion-review-bar .suggestion-review-comment-submit').click()
    })
  }
  window.annotationsSceneClickShowProposal = async () => {
    requireElement<HTMLButtonElement>(paneHost, '[data-annotation-detail] .annotation-action-show-proposal').click()
    await settle()
    return revealedRanges
  }
  window.annotationsSceneClickReattach = async () => {
    requireElement<HTMLButtonElement>(paneHost, '[data-annotation-detail] [data-annotation-action="reattach"]').click()
    await settle()
    return reattachedIds
  }
  window.annotationsSceneTypeThroughEcho = async (index, text) => {
    const input = noteFieldAt(index)
    typeInto(input, text)
    await nextTick()
    // The broadcast a commit provokes, carrying the provider's own note for
    // every chunk. It re-renders the controls while the reviewer is still
    // in the field with characters they have not sent.
    const review = reviewedSession.review
    if (review === undefined) {
      throw new Error('the reviewed scene session carries no review')
    }
    collaborationStore.sessionsByDocumentPath[SCENE_DOCUMENT_PATH] = {
      ...reviewedSession,
      review: {
        ...review,
        reviewGeneration: review.reviewGeneration + 1,
        chunkComments: review.suggestions.map(suggestion => ({
          chunkId: suggestion.suggestionId,
          comment: 'the provider\'s own note'
        }))
      }
    }
    await settle()
    const after = noteFieldAt(index)
    return { value: after.value, focused: document.activeElement === after }
  }

  window.annotationsSceneDiagnostics = () => {
    const thread = paneHost.querySelector<HTMLElement>('[data-annotation-detail]')
    const bar = paneHost.querySelector<HTMLElement>('.suggestion-review-bar')
    return {
      annotationRowCount: panelHost.querySelectorAll('.annotation-workspace-annotation').length,
      suggestionRowCount: panelHost.querySelectorAll('.annotation-workspace-suggestion').length,
      documentAcceptAllCount: panelHost.querySelectorAll('.annotation-document-accept-all').length,
      globalAcceptAllPresent: panelHost.querySelector('.annotation-global-accept-all') !== null,
      headingCount: panelHost.querySelectorAll('h1, h2, h3').length,
      shortcutChip: panelHost.querySelector('.annotation-header-shortcut')?.textContent?.trim() ?? '',
      threadIds: [...paneHost.querySelectorAll('[data-annotation-detail]')].map(element => element.getAttribute('data-annotation-id') ?? ''),
      threadLifecycle: thread?.querySelector('.annotation-lifecycle-pill')?.textContent?.trim() ?? '',
      composerPresent: thread !== null && thread.querySelector('.annotation-composer textarea') !== null,
      resolveCount: paneHost.querySelectorAll('[data-annotation-detail] [data-annotation-action="resolve"]').length,
      resolveLabel: thread?.querySelector('[data-annotation-action="resolve"]')?.textContent?.trim() ?? '',
      reattachPresent: thread !== null && thread.querySelector('[data-annotation-action="reattach"]') !== null,
      showProposalLabel: thread?.querySelector('.annotation-action-show-proposal')?.textContent?.trim() ?? '',
      proposalCardText: thread?.querySelector('.proposal-action-card')?.textContent ?? null,
      messageTimes: [...paneHost.querySelectorAll('.annotation-message-time')].map(element => element.textContent?.trim() ?? ''),
      chunkControlCount: paneHost.querySelectorAll('.suggestion-chunk').length,
      acceptCount: paneHost.querySelectorAll('.suggestion-chunk .suggestion-decision.accept').length,
      rejectCount: paneHost.querySelectorAll('.suggestion-chunk .suggestion-decision.reject').length,
      chunkNoteValues: [...paneHost.querySelectorAll<HTMLInputElement>('input.suggestion-chunk-comment')].map(input => input.value),
      reviewBarPresent: bar !== null,
      reviewBarLabel: bar?.querySelector('.suggestion-review-count')?.textContent?.trim() ?? '',
      reviewBarMassActionCount: bar === null ? 0 : bar.querySelectorAll('.suggestion-accept-all, .suggestion-clear').length,
      reviewCommentPresent: bar !== null && bar.querySelector('.suggestion-review-comment-submit') !== null
    }
  }

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.annotationsSceneWorkingText = SCENE_WORKING_TEXT
window.captureReady = mount()

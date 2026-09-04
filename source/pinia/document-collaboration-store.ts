/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useDocumentCollaborationStore
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The renderer's one cache of DocumentCollaborationSession
 *                  snapshots, keyed by document path. Every pane and the
 *                  annotations panel read a document's collaboration state
 *                  from here — never from a per-pane IPC pull, and never
 *                  from the sidecar. A document's session enters the cache
 *                  exactly once, through whichever caller asks for it
 *                  first (ensureSession), and every subsequent change
 *                  reaches every caller through the same
 *                  DP_EVENTS.DOCUMENT_COLLABORATION broadcast this store is
 *                  the sole listener for.
 *
 *                  The panel-only fields below (selectedAnnotationId,
 *                  inspectorMode, showResolved) and the mutation actions
 *                  were left for the annotations panel to add: nothing here
 *                  is read by more than one pane, so nothing here needed to
 *                  exist before the panel did. The mutation actions never
 *                  write sessionsByDocumentPath themselves — every owner
 *                  action goes over IPC to CollaborationApplicationService
 *                  and reaches this cache only through the broadcast
 *                  handler above, the same as any other mutation.
 *
 *                  Both halves of the session are mutated from here, and
 *                  both go over the provider's typed operation channels:
 *                  the annotation calls on 'documents:*-annotation', the
 *                  review calls (M9, moved out of the editor's chunk
 *                  widgets) on 'documents:*-review-*'. The payload and the
 *                  response of each are the main-process handler's own
 *                  signature, so a wrong field here is a compile error
 *                  rather than a runtime refusal.
 *
 * END HEADER
 */

import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { DP_EVENTS } from '@dts/common/documents'
import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { AnnotationMessage, TextAnnotation } from '@dts/common/annotation-domain'
import type { AnnotationLifecycleIpcInput, DocumentsUpdateContext } from 'source/app/service-providers/documents'
import type { AnnotationFailure, ReviewFailure, ReviewMutationPrecondition } from 'source/app/service-providers/documents/document-collaboration-application-service'
import type {
  AcceptAllChunksResponse,
  AddReviewCommentResponse,
  ChunkCommentResponse,
  ChunkDecisionResponse,
  ClearReviewResponse
} from 'source/app/service-providers/documents/review-transitions'

const ipcRenderer = window.ipc

/** The annotations panel's two arrangements: both the list and the detail
 *  inspector at once (the wide layout), or one at a time behind a
 *  back-button drilldown (the narrow layout, S structural gate 11). */
export type AnnotationInspectorMode = 'list' | 'detail'

export const useDocumentCollaborationStore = defineStore('document-collaboration', () => {
  const sessionsByDocumentPath = reactive<Record<string, DocumentCollaborationSession>>({})
  const selectedAnnotationId = ref<string | null>(null)
  const inspectorMode = ref<AnnotationInspectorMode>('list')
  const showResolved = ref(false)

  // Fetches in flight, keyed by path. Two panes mounting on the same
  // document in the same tick must not turn into two IPC reads: the second
  // caller joins the first caller's promise instead of starting its own.
  const pendingFetches = new Map<string, Promise<void>>()

  ipcRenderer.on('documents-update', (_event, payload: { event: DP_EVENTS, context: DocumentsUpdateContext }) => {
    const { event, context } = payload
    if (event === DP_EVENTS.DOCUMENT_COLLABORATION && context.filePath !== undefined) {
      // ponytail: a broadcast is trusted to be newer than whatever is
      // cached, with no generation comparison against a fetch that might
      // still be in flight for the same path. The read path that fetch
      // resolves through does no disk I/O, while every mutation that can
      // produce a broadcast writes the sidecar first — so a fetch issued
      // around the same time as a mutation resolves before that mutation's
      // broadcast in practice. Add a per-half generation guard here if a
      // real out-of-order arrival is ever observed.
      if (context.collaborationSession !== undefined) {
        sessionsByDocumentPath[context.filePath] = context.collaborationSession
      }
    } else if (event === DP_EVENTS.CLOSE_FILE && context.filePath !== undefined) {
      delete sessionsByDocumentPath[context.filePath]
      pendingFetches.delete(context.filePath)
    }
  })

  /**
   * Hydrate the cache for one document path. The first caller for a path —
   * a pane on mount, or the panel — performs the one IPC read; every other
   * caller for that same path, concurrent or later, reuses the cached
   * session or the fetch already in flight. Every change after hydration
   * reaches the cache through the broadcast handler above, never through a
   * second call here.
   */
  async function ensureSession (documentPath: string): Promise<void> {
    if (documentPath in sessionsByDocumentPath) {
      return
    }
    const inFlight = pendingFetches.get(documentPath)
    if (inFlight !== undefined) {
      return await inFlight
    }
    const fetch = ipcRenderer.invoke('documents-provider', {
      command: 'get-collaboration-session',
      payload: { path: documentPath }
    })
      .then((session: DocumentCollaborationSession | undefined) => {
        if (session !== undefined) {
          sessionsByDocumentPath[documentPath] = session
        }
      })
      .catch((err: unknown) => {
        console.error(`[documentCollaborationStore] Could not fetch the collaboration session for ${documentPath}`, err)
      })
      .finally(() => {
        pendingFetches.delete(documentPath)
      })
    pendingFetches.set(documentPath, fetch)
    return await fetch
  }

  function getSession (documentPath: string): DocumentCollaborationSession | undefined {
    return sessionsByDocumentPath[documentPath]
  }

  /** Select an annotation in the panel, or clear the selection (null). The
   *  narrow-width layout reads inspectorMode to decide which of its two
   *  panes to show, so selecting one drills into the detail. */
  function selectAnnotation (annotationId: string | null): void {
    selectedAnnotationId.value = annotationId
    inspectorMode.value = annotationId === null ? 'list' : 'detail'
  }

  function toggleShowResolved (value?: boolean): void {
    showResolved.value = value ?? !showResolved.value
  }

  /**
   * The fence an annotation mutation carries: which document, which
   * annotation, and the generation of the snapshot the panel rendered that
   * annotation from. Every one of the four calls below names it, and two of
   * them add a field of their own. No call names an actor: the handlers
   * hardcode 'owner' and their input types declare no such field, so the
   * renderer cannot claim to be anyone else.
   */
  function annotationFence (documentPath: string, annotationId: string): AnnotationLifecycleIpcInput {
    return {
      path: documentPath,
      annotationId,
      expectedAnnotationGeneration: sessionsByDocumentPath[documentPath]?.annotations.generation ?? 0
    }
  }

  /**
   * Every one of these four calls is the whole of what an owner control in
   * the panel is allowed to do: ask CollaborationApplicationService, over
   * IPC, for the mutation, and hand the caller its result. None of them
   * touches sessionsByDocumentPath — the resulting DocumentCollaborationSession
   * reaches this cache only through the DP_EVENTS.DOCUMENT_COLLABORATION
   * broadcast the mutation itself provokes, the same path every other
   * mutation (including another pane's) already takes.
   */
  async function addAnnotationMessage (documentPath: string, annotationId: string, text: string): Promise<AnnotationMessage | AnnotationFailure> {
    return await ipcRenderer.invoke('documents:add-annotation-message', {
      ...annotationFence(documentPath, annotationId),
      text
    })
  }

  async function resolveAnnotation (documentPath: string, annotationId: string): Promise<TextAnnotation | AnnotationFailure> {
    return await ipcRenderer.invoke('documents:resolve-annotation', annotationFence(documentPath, annotationId))
  }

  async function reopenAnnotation (documentPath: string, annotationId: string): Promise<TextAnnotation | AnnotationFailure> {
    return await ipcRenderer.invoke('documents:reopen-annotation', annotationFence(documentPath, annotationId))
  }

  /** S8: reattachment is a visible owner action, never a background guess —
   *  the caller supplies the new range the owner just selected. */
  async function reattachAnnotation (documentPath: string, annotationId: string, from: number, to: number): Promise<TextAnnotation | AnnotationFailure> {
    return await ipcRenderer.invoke('documents:reattach-annotation', {
      ...annotationFence(documentPath, annotationId),
      from,
      to
    })
  }

  /**
   * The fence a review mutation carries: the generation and the exact working
   * bytes of the snapshot the panel rendered the chunk from. Both come out of
   * the cached DocumentCollaborationSession, which is also what the owner is
   * looking at — an owner keystroke on a reviewed document rebroadcasts, so
   * this pair moves with the text rather than going stale behind it.
   *
   * A mutation with no cached review has no chunk to name, so this throws
   * instead of inventing a fence: the panel only offers these controls while
   * `session.review` exists.
   */
  function reviewFence (documentPath: string): { reviewId: string } & ReviewMutationPrecondition {
    const session = sessionsByDocumentPath[documentPath]
    if (session?.review === undefined) {
      throw new Error(`No review is active on ${documentPath}`)
    }
    return {
      reviewId: session.review.id,
      expectedReviewGeneration: session.review.reviewGeneration,
      expectedWorkingSha256: session.workingSha256
    }
  }

  /**
   * The five review adjudication calls the SuggestionInspector makes (M9).
   * Like the annotation mutations above, none of them writes
   * sessionsByDocumentPath: the resulting session reaches this cache only
   * through the DP_EVENTS.DOCUMENT_COLLABORATION broadcast the mutation
   * provokes. Each resolves to the provider's own response, so a refusal is
   * a value the caller surfaces rather than a rejection it has to catch.
   */
  async function decideReviewChunk (documentPath: string, chunkId: string, decision: 'accept' | 'reject'): Promise<ChunkDecisionResponse | ReviewFailure> {
    return await ipcRenderer.invoke('documents:decide-review-chunk', {
      ...reviewFence(documentPath),
      chunkId,
      decision
    })
  }

  /** Annotate one outstanding chunk without deciding it; empty text removes the note. */
  async function commentReviewChunk (documentPath: string, chunkId: string, text: string): Promise<ChunkCommentResponse | ReviewFailure> {
    return await ipcRenderer.invoke('documents:comment-review-chunk', {
      ...reviewFence(documentPath),
      chunkId,
      text
    })
  }

  async function acceptAllReviewChunks (documentPath: string): Promise<AcceptAllChunksResponse | ReviewFailure> {
    return await ipcRenderer.invoke('documents:accept-all-review-chunks', reviewFence(documentPath))
  }

  async function clearReview (documentPath: string): Promise<ClearReviewResponse | ReviewFailure> {
    return await ipcRenderer.invoke('documents:clear-review', reviewFence(documentPath))
  }

  /** A review-level comment adjudicates nothing and moves no text, so it
   *  fences on the generation alone — the working hash has no reader. */
  async function addReviewComment (documentPath: string, text: string): Promise<AddReviewCommentResponse | ReviewFailure> {
    const { reviewId, expectedReviewGeneration } = reviewFence(documentPath)
    return await ipcRenderer.invoke('documents:add-review-comment', {
      reviewId,
      text,
      expectedReviewGeneration
    })
  }

  return {
    sessionsByDocumentPath,
    selectedAnnotationId,
    inspectorMode,
    showResolved,
    ensureSession,
    getSession,
    selectAnnotation,
    toggleShowResolved,
    addAnnotationMessage,
    resolveAnnotation,
    reopenAnnotation,
    reattachAnnotation,
    decideReviewChunk,
    commentReviewChunk,
    acceptAllReviewChunks,
    clearReview,
    addReviewComment
  }
})

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
 *                  The workspace panel also asks this store for one merged
 *                  projection spanning loaded workspace paths, including
 *                  detached sidecars supplied by DocumentManager.
 *                  selectedAnnotationId names the annotation whose thread
 *                  is open in the editor; showResolved decides whether
 *                  resolved annotations render there. Mutation actions never
 *                  write cached sessions directly — provider state returns
 *                  through the collaboration broadcast or an explicit
 *                  workspace refresh.
 *
 *                  Both halves of the session are mutated from here, and
 *                  both go over the provider's typed operation channels:
 *                  the annotation calls on 'documents:*-annotation', the
 *                  review calls on 'documents:*-review-*'. The editor's
 *                  inline controls and the workspace panel are the
 *                  callers. The payload and the
 *                  response of each are the main-process handler's own
 *                  signature, so a wrong field here is a compile error
 *                  rather than a runtime refusal.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { DP_EVENTS } from '@dts/common/documents'
import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { AnnotationMessage, TextAnnotation } from '@dts/common/annotation-domain'
import { buildAnnotationCards, unresolvedCollaborationCount, type AnnotationCardView } from 'source/win-main/sidebar/annotations/annotation-panel-model'
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

export const useDocumentCollaborationStore = defineStore('document-collaboration', () => {
  const sessionsByDocumentPath = reactive<Record<string, DocumentCollaborationSession>>({})
  const cardsByDocumentPath = reactive<Record<string, AnnotationCardView[]>>({})
  const selectedAnnotationId = ref<string | null>(null)
  const showResolved = ref(false)
  const workspaceDocumentPaths = ref<string[]>([])
  const workspacePathSet = new Set<string>()
  let workspaceRefreshGeneration = 0

  const workspaceSessions = computed(() => workspaceDocumentPaths.value
    .map(path => sessionsByDocumentPath[path])
    .filter((session): session is DocumentCollaborationSession => session !== undefined))

  const workspaceUnresolvedCount = computed(() => workspaceSessions.value
    .reduce((total, session) => total + unresolvedCollaborationCount(session), 0))

  function updateCardsForSession (documentPath: string, session: DocumentCollaborationSession): void {
    cardsByDocumentPath[documentPath] = buildAnnotationCards(session.annotations.items, session.workingText)
  }

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
        updateCardsForSession(context.filePath, context.collaborationSession)
      }
    } else if (event === DP_EVENTS.CLOSE_FILE && context.filePath !== undefined) {
      // Workspace panel state outlives editor panes. A closed workspace
      // document keeps its last authoritative snapshot until the next
      // workspace refresh projects its persisted sidecar.
      if (!workspacePathSet.has(context.filePath)) {
        delete sessionsByDocumentPath[context.filePath]
        delete cardsByDocumentPath[context.filePath]
      }
      pendingFetches.delete(context.filePath)
    }
  })

  // Precompute cards in the background whenever sessionsByDocumentPath updates
  watch(
    sessionsByDocumentPath,
    (sessions) => {
      for (const [path, session] of Object.entries(sessions)) {
        if (session !== undefined) {
          updateCardsForSession(path, session)
        }
      }
    },
    { deep: true }
  )

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
          updateCardsForSession(documentPath, session)
        }
      })
      .catch((err: unknown) => {
        reportError(`[documentCollaborationStore] Could not fetch the collaboration session for ${documentPath}`, err)
      })
      .finally(() => {
        pendingFetches.delete(documentPath)
      })
    pendingFetches.set(documentPath, fetch)
    return await fetch
  }

  /**
   * Replace the panel's workspace projection with the provider's merged live
   * + detached collaboration sessions for these file paths.
   */
  async function refreshWorkspaceSessions (paths: readonly string[]): Promise<void> {
    const refreshGeneration = ++workspaceRefreshGeneration
    const uniquePaths = [...new Set(paths)]
    workspaceDocumentPaths.value = uniquePaths
    workspacePathSet.clear()
    for (const path of uniquePaths) {
      workspacePathSet.add(path)
    }

    const sessions = await ipcRenderer.invoke('documents-provider', {
      command: 'get-workspace-collaboration-sessions',
      payload: { paths: uniquePaths }
    }) as DocumentCollaborationSession[]
    if (refreshGeneration !== workspaceRefreshGeneration) {
      return
    }
    const returned = new Set(sessions.map(session => session.documentPath))

    for (const path of uniquePaths) {
      if (!returned.has(path)) {
        delete sessionsByDocumentPath[path]
        delete cardsByDocumentPath[path]
      }
    }
    for (const session of sessions) {
      sessionsByDocumentPath[session.documentPath] = session
      updateCardsForSession(session.documentPath, session)
    }
  }

  function getSession (documentPath: string): DocumentCollaborationSession | undefined {
    return sessionsByDocumentPath[documentPath]
  }

  function getCards (documentPath: string): AnnotationCardView[] {
    const cached = cardsByDocumentPath[documentPath]
    if (cached !== undefined) {
      return cached
    }
    const session = sessionsByDocumentPath[documentPath]
    if (session !== undefined) {
      const computedCards = buildAnnotationCards(session.annotations.items, session.workingText)
      cardsByDocumentPath[documentPath] = computedCards
      return computedCards
    }
    return []
  }

  /** Mark one annotation active in editor locator rendering, or clear it. */
  function selectAnnotation (annotationId: string | null): void {
    selectedAnnotationId.value = annotationId
  }

  function toggleShowResolved (value?: boolean): void {
    showResolved.value = value ?? !showResolved.value
  }

  /**
   * The fence an annotation mutation carries: which document, which
   * annotation, and the generation of the snapshot the thread rendered that
   * annotation from. Every one of the five calls below names it, and two of
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
   * Every one of these five calls is the whole of what an owner control in
   * an annotation thread is allowed to do: ask CollaborationApplicationService, over
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

  /** Removes an annotation, its thread and its proposals. Resolving keeps them; this does not. */
  async function deleteAnnotation (documentPath: string, annotationId: string): Promise<TextAnnotation | AnnotationFailure> {
    return await ipcRenderer.invoke('documents:delete-annotation', annotationFence(documentPath, annotationId))
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
   * bytes of the snapshot the chunk controls rendered from. Both come out of
   * the cached DocumentCollaborationSession, which is also what the owner is
   * looking at — an owner keystroke on a reviewed document rebroadcasts, so
   * this pair moves with the text rather than going stale behind it.
   *
   * A mutation with no cached review has no chunk to name, so this throws
   * instead of inventing a fence: the editor only places these controls while
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
   * Review adjudication calls. The editor's inline controls decide, note,
   * accept all, clear and comment on the review of the document they show;
   * the workspace panel uses the workspace accept-all variants.
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

  async function acceptAllWorkspaceReviewChunks (documentPath: string): Promise<AcceptAllChunksResponse | ReviewFailure> {
    const result = await ipcRenderer.invoke('documents:accept-all-workspace-review-chunks', {
      path: documentPath,
      ...reviewFence(documentPath)
    }) as AcceptAllChunksResponse | ReviewFailure
    if (result.ok) {
      await refreshWorkspaceSessions(workspaceDocumentPaths.value)
    }
    return result
  }

  async function acceptAllWorkspaceReviews (): Promise<Array<{ path: string, result: AcceptAllChunksResponse | ReviewFailure }>> {
    const targets = workspaceSessions.value
      .filter(session => (session.review?.suggestions.length ?? 0) > 0)
      .map(session => session.documentPath)
    const results: Array<{ path: string, result: AcceptAllChunksResponse | ReviewFailure }> = []
    for (const path of targets) {
      const result = await ipcRenderer.invoke('documents:accept-all-workspace-review-chunks', {
        path,
        ...reviewFence(path)
      }) as AcceptAllChunksResponse | ReviewFailure
      results.push({ path, result })
    }
    await refreshWorkspaceSessions(workspaceDocumentPaths.value)
    return results
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
    cardsByDocumentPath,
    workspaceDocumentPaths,
    workspaceSessions,
    workspaceUnresolvedCount,
    selectedAnnotationId,
    showResolved,
    ensureSession,
    refreshWorkspaceSessions,
    getSession,
    getCards,
    selectAnnotation,
    toggleShowResolved,
    addAnnotationMessage,
    resolveAnnotation,
    reopenAnnotation,
    deleteAnnotation,
    reattachAnnotation,
    decideReviewChunk,
    commentReviewChunk,
    acceptAllReviewChunks,
    acceptAllWorkspaceReviewChunks,
    acceptAllWorkspaceReviews,
    clearReview,
    addReviewComment
  }
})

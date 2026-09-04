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
 * END HEADER
 */

import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { DP_EVENTS } from '@dts/common/documents'
import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { DocumentsUpdateContext } from 'source/app/service-providers/documents'

const ipcRenderer = window.ipc

export const useDocumentCollaborationStore = defineStore('document-collaboration', () => {
  const sessionsByDocumentPath = reactive<Record<string, DocumentCollaborationSession>>({})

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

  return { sessionsByDocumentPath, ensureSession, getSession }
})

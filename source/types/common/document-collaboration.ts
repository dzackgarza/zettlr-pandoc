/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document collaboration renderer snapshot
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one shape every renderer pane and the annotations
 *                  panel read collaboration state from. It carries both
 *                  halves of a document's collaboration state — its
 *                  annotations and its review, if one is active — because a
 *                  pane that read them from two separate broadcasts could
 *                  observe one half updated and the other still stale.
 *
 *                  This is the ONLY collaboration shape a renderer surface
 *                  may read: it is broadcast on DP_EVENTS.DOCUMENT_COLLABORATION
 *                  and cached in the document-collaboration Pinia store, and
 *                  nothing downstream of that store may go around it to read
 *                  the sidecar directly.
 *
 * END HEADER
 */

import type { AnnotationSet } from './annotation-domain'
import type { ReviewDiffSession } from './review-diff'

export interface DocumentCollaborationSession {
  documentId: string
  documentPath: string
  /** The provider-authoritative working bytes this snapshot was taken from. */
  workingText: string
  workingSha256: string
  /** Never absent: an annotation-only document reports an empty set. */
  annotations: AnnotationSet
  /** Absent when the document carries no active review. */
  review: ReviewDiffSession | undefined
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceIndex class
 * CVM-Role:        Utility Class
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure workspace reference index behind the references
 *                  service provider (issue #1, reworked for issue #53). It
 *                  merges FSAL-owned saved snapshots with authority-fed
 *                  live-buffer snapshots and resolves the merged view. This
 *                  module is Electron-free by design: the provider shell owns
 *                  ipcMain wiring, FSAL event subscription, the document
 *                  authority seam, and broadcasting, and delegates every
 *                  state transition to this class:
 *
 *                  - FSAL reindex/change      -> applySavedSnapshot()
 *                  - FSAL unlink              -> removeSavedSnapshot()
 *                  - authority buffer change  -> reportLiveBuffer()
 *                  - authority buffer closed  -> dropLiveBuffer()
 *                  - 'get-snapshot'           -> getSnapshot()
 *
 * END HEADER
 */

import type { DocumentReferenceSnapshot, Resolution } from '@dts/common/references'
import { resolveWorkspace } from '@common/pandoc-util/resolve-references'

/**
 * The complete workspace reference state served to every consumer: exactly
 * one snapshot per known document (a live overlay replaces the saved snapshot
 * for its document) plus the resolution map computed over that merged view.
 */
export interface WorkspaceReferenceState {
  snapshots: DocumentReferenceSnapshot[]
  resolutions: Map<string, Resolution>
}

/**
 * Maintains the authoritative merged reference view of the workspace.
 *
 * Overlay authority rule (the contract proven by
 * test/reference-index-overlay.spec.ts):
 *
 * A live buffer's snapshot REPLACES the saved FSAL snapshot for its document
 * in every output. The live side is fed exclusively by the main-process
 * document authority (issue #53): the provider derives every live snapshot
 * from the authority's own buffer text, so reports arrive in document order
 * by construction and the LAST report always wins — there is no generation
 * counter and no reconciliation protocol, because no second process ever
 * feeds this map. A saved FSAL snapshot never evicts an overlay (the overlay
 * exists exactly as long as the authority holds the buffer open); dropping
 * the live buffer reverts to the saved snapshot. Removing the saved snapshot
 * (FSAL unlink) removes the document entirely unless a live overlay exists,
 * in which case the overlay stays authoritative.
 */
export class ReferenceIndex {
  /** Saved (on-disk) snapshots by documentPath, owned by FSAL events. */
  private readonly saved: Map<string, DocumentReferenceSnapshot>
  /** Live-buffer overlays by documentPath, owned by the document authority. */
  private readonly live: Map<string, DocumentReferenceSnapshot>

  constructor () {
    this.saved = new Map()
    this.live = new Map()
  }

  /**
   * Applies a saved snapshot reported by FSAL for the snapshot's document.
   * A live overlay for the same document stays authoritative: the authority
   * (not FSAL) decides when the live side ends, by dropping the buffer.
   *
   * @param   {DocumentReferenceSnapshot}  snapshot  The saved snapshot
   */
  applySavedSnapshot (snapshot: DocumentReferenceSnapshot): void {
    this.saved.set(snapshot.documentPath, snapshot)
  }

  /**
   * Removes the saved snapshot for a document (FSAL unlink event).
   *
   * @param   {string}  documentPath  The unlinked document's path
   */
  removeSavedSnapshot (documentPath: string): void {
    // An unlink never touches a live overlay: an open buffer stays
    // authoritative until it is dropped.
    this.saved.delete(documentPath)
  }

  /**
   * Reports a live buffer's snapshot, derived by the provider from the
   * document authority's own text. The snapshot replaces the saved snapshot
   * for its document; the last report wins unconditionally (the single
   * feeder is the in-order main-process authority).
   *
   * @param   {DocumentReferenceSnapshot}  snapshot  The live snapshot
   */
  reportLiveBuffer (snapshot: DocumentReferenceSnapshot): void {
    this.live.set(snapshot.documentPath, snapshot)
  }

  /**
   * Drops the live overlay for a document, reverting to its saved snapshot.
   *
   * @param   {string}  documentPath  The closed document's path
   *
   * @return  {boolean}               True when an overlay actually existed
   */
  dropLiveBuffer (documentPath: string): boolean {
    return this.live.delete(documentPath)
  }

  /**
   * Returns the merged workspace state: one snapshot per known document with
   * live overlays replacing saved snapshots, and the resolutions computed
   * over exactly that merged view.
   *
   * @return  {WorkspaceReferenceState}  The merged workspace reference state
   */
  getSnapshot (): WorkspaceReferenceState {
    const snapshots: DocumentReferenceSnapshot[] = []

    for (const [ documentPath, snapshot ] of this.saved) {
      snapshots.push(this.live.get(documentPath) ?? snapshot)
    }

    // Documents that only exist as open buffers (e.g. unlinked but still
    // open, or open files FSAL has never indexed) are part of the merged
    // view too.
    for (const [ documentPath, snapshot ] of this.live) {
      if (!this.saved.has(documentPath)) {
        snapshots.push(snapshot)
      }
    }

    return { snapshots, resolutions: resolveWorkspace(snapshots) }
  }
}

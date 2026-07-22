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
 *                  service provider (issue #1). It merges FSAL-owned saved
 *                  snapshots with renderer-reported live-buffer snapshots and
 *                  resolves the merged view. This module is Electron-free by
 *                  design: the provider shell owns ipcMain wiring, FSAL event
 *                  subscription, and broadcasting, and delegates every state
 *                  transition to this class:
 *
 *                  - FSAL reindex/change  -> applySavedSnapshot()
 *                  - FSAL unlink          -> removeSavedSnapshot()
 *                  - 'report-live-buffer' -> reportLiveBuffer()
 *                  - 'drop-live-buffer'   -> dropLiveBuffer()
 *                  - 'get-snapshot'       -> getSnapshot()
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
 * A live-buffer overlay: the reported snapshot together with the editor
 * transaction generation it was reported at.
 */
interface LiveOverlay {
  snapshot: DocumentReferenceSnapshot
  generation: number
}

/**
 * Maintains the authoritative merged reference view of the workspace.
 *
 * Overlay authority rule (the contract proven by
 * test/reference-index-overlay.spec.ts):
 *
 * A reported live buffer's snapshot REPLACES the saved FSAL snapshot for its
 * document in every output. The overlay remains authoritative until FSAL
 * reports a saved snapshot whose sourceHash exactly equals the live one's AND
 * no newer generation has been reported since. A stale FSAL event (hash
 * differing from the current live buffer's) never evicts the overlay. An
 * out-of-order live report (older generation than the current one) is
 * ignored. Dropping the live buffer reverts to the saved snapshot. Removing
 * the saved snapshot (FSAL unlink) removes the document entirely unless a
 * live overlay exists, in which case the overlay stays authoritative.
 */
export class ReferenceIndex {
  /** Saved (on-disk) snapshots by documentPath, owned by FSAL events. */
  private readonly saved: Map<string, DocumentReferenceSnapshot>
  /** Live-buffer overlays by documentPath, owned by renderer reports. */
  private readonly live: Map<string, LiveOverlay>

  constructor () {
    this.saved = new Map()
    this.live = new Map()
  }

  /**
   * Applies a saved snapshot reported by FSAL for the snapshot's document.
   *
   * @param   {DocumentReferenceSnapshot}  snapshot  The saved snapshot
   */
  applySavedSnapshot (snapshot: DocumentReferenceSnapshot): void {
    this.saved.set(snapshot.documentPath, snapshot)

    // Eviction: the overlay hands authority back only when the saved content
    // is exactly the current live buffer's content. Out-of-order live reports
    // are dropped in reportLiveBuffer(), so the retained overlay always
    // carries the newest reported generation: a hash match against it means
    // no newer generation has been reported since that content was current.
    // A differing hash is a stale FSAL event and never evicts.
    const overlay = this.live.get(snapshot.documentPath)
    if (overlay !== undefined && overlay.snapshot.sourceHash === snapshot.sourceHash) {
      this.live.delete(snapshot.documentPath)
    }
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
   * Reports a live editor buffer's snapshot together with its transaction
   * generation. The snapshot replaces the saved snapshot for its document.
   *
   * @param   {DocumentReferenceSnapshot}  snapshot    The live snapshot
   * @param   {number}                     generation  The editor generation
   */
  reportLiveBuffer (snapshot: DocumentReferenceSnapshot, generation: number): void {
    // Monotonic generation guard: an out-of-order report carrying an older
    // generation than the current overlay's is ignored.
    const overlay = this.live.get(snapshot.documentPath)
    if (overlay !== undefined && generation < overlay.generation) {
      return
    }

    this.live.set(snapshot.documentPath, { snapshot, generation })
  }

  /**
   * Drops the live overlay for a document, reverting to its saved snapshot.
   *
   * @param   {string}  documentPath  The closed document's path
   */
  dropLiveBuffer (documentPath: string): void {
    this.live.delete(documentPath)
  }

  /**
   * Returns the sourceHash of the live-buffer overlay for a document, or
   * undefined when the document has no live overlay. This is the commit-time
   * partitioning seam of the workspace rename protocol: documents WITH an
   * overlay belong to renderer CodeMirror buffers (verified against the
   * overlay hash, applied as returned transactions), documents WITHOUT one
   * are closed files (verified against a fresh disk read, applied as atomic
   * disk writes).
   *
   * @param   {string}  documentPath  The document's path
   *
   * @return  {string|undefined}      The overlay's sourceHash, if one exists
   */
  liveBufferSourceHash (documentPath: string): string|undefined {
    return this.live.get(documentPath)?.snapshot.sourceHash
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
      snapshots.push(this.live.get(documentPath)?.snapshot ?? snapshot)
    }

    // Documents that only exist as open buffers (e.g. unlinked but still
    // open) are part of the merged view too.
    for (const [ documentPath, overlay ] of this.live) {
      if (!this.saved.has(documentPath)) {
        snapshots.push(overlay.snapshot)
      }
    }

    return { snapshots, resolutions: resolveWorkspace(snapshots) }
  }
}

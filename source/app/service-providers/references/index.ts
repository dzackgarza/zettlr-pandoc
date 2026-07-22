/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceProvider class
 * CVM-Role:        Service Provider
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Electron shell around the pure ReferenceIndex
 *                  (./reference-index.ts) for issue #1 Phase 3b.
 *
 *                  CONTRACT (locked by test/reference-provider-shell.spec.ts):
 *
 *                  - The constructor follows the LinkProvider pattern
 *                    (../links/index.ts): it receives its LogProvider and
 *                    FSAL dependencies by injection and registers exactly one
 *                    ipcMain.handle('reference-provider', …) handler whose
 *                    commands delegate 1:1 to the ReferenceIndex per that
 *                    class's own delegation map:
 *
 *                      'get-snapshot'       -> index.getSnapshot()
 *                      'report-live-buffer' -> index.reportLiveBuffer(
 *                                                payload.snapshot,
 *                                                payload.generation)
 *                      'drop-live-buffer'   -> index.dropLiveBuffer(
 *                                                payload.documentPath)
 *
 *                  - boot() subscribes to the injected FSAL's 'fsal-event':
 *                    'add'/'change' events carrying a markdown file
 *                    descriptor apply that descriptor's FSAL-owned saved
 *                    snapshot (descriptor.references) via
 *                    index.applySavedSnapshot(); 'unlink' events remove the
 *                    saved snapshot via index.removeSavedSnapshot(path).
 *                    After every state transition the provider broadcasts
 *                    'references' to all windows (broadcastIpcMessage), which
 *                    MainEditor.vue already consumes to refresh the combined
 *                    @-completion database.
 *
 *                  - getSnapshot() exposes the same merged
 *                    WorkspaceReferenceState the ipc handler serves, for
 *                    main-process consumers.
 *
 *                  - shutdown() unsubscribes the FSAL event listener.
 *
 * END HEADER
 */

import { ipcMain } from 'electron'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import type FSAL from '../fsal'
import type { FSALEventPayload } from '../fsal'
import type { DocumentReferenceSnapshot } from '@dts/common/references'
import { ReferenceIndex, type WorkspaceReferenceState } from './reference-index'

/**
 * Serves the merged workspace reference view (saved FSAL snapshots overlaid
 * by renderer-reported live buffers) to every consumer over the
 * 'reference-provider' ipc channel.
 */
export default class ReferenceProvider extends ProviderContract {
  private readonly _index: ReferenceIndex

  /**
   * Applies FSAL state transitions to the index: 'add'/'change' events
   * carrying a markdown file descriptor apply its FSAL-owned saved snapshot,
   * 'unlink' events remove the document's saved snapshot. Every applied
   * transition is announced with a 'references' broadcast.
   */
  private readonly _onFsalEvent = (payload: FSALEventPayload): void => {
    if (payload.event === 'unlink') {
      this._index.removeSavedSnapshot(payload.path)
      broadcastIpcMessage('references')
    } else if ((payload.event === 'add' || payload.event === 'change') && payload.descriptor.type === 'file') {
      this._index.applySavedSnapshot(payload.descriptor.references)
      broadcastIpcMessage('references')
    }
  }

  constructor (
    private readonly _logger: LogProvider,
    private readonly _fsal: FSAL
  ) {
    super()
    this._index = new ReferenceIndex()

    ipcMain.handle('reference-provider', (_event, message: { command: string, payload?: unknown }) => {
      const { command } = message

      if (command === 'get-snapshot') {
        return this._index.getSnapshot()
      } else if (command === 'report-live-buffer') {
        const { snapshot, generation } = message.payload as { snapshot: DocumentReferenceSnapshot, generation: number }
        this._index.reportLiveBuffer(snapshot, generation)
        broadcastIpcMessage('references')
      } else if (command === 'drop-live-buffer') {
        const { documentPath } = message.payload as { documentPath: string }
        this._index.dropLiveBuffer(documentPath)
        broadcastIpcMessage('references')
      }
    })
  }

  /**
   * Subscribes to the injected FSAL's 'fsal-event' stream so saved snapshots
   * follow the on-disk workspace state.
   */
  public async boot (): Promise<void> {
    this._fsal.on('fsal-event', this._onFsalEvent)
  }

  /**
   * Returns the merged workspace reference state — the same state the ipc
   * surface serves.
   *
   * @return  {WorkspaceReferenceState}  The merged workspace reference state
   */
  public getSnapshot (): WorkspaceReferenceState {
    return this._index.getSnapshot()
  }

  /**
   * Shuts down the service provider, unsubscribing from FSAL events.
   */
  public async shutdown (): Promise<void> {
    this._fsal.off('fsal-event', this._onFsalEvent)
    this._logger.verbose('Reference provider shutting down ...')
  }
}

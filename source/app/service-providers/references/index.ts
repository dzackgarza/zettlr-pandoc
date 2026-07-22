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
 *                  CONTRACT (locked red by test/reference-provider-shell.spec.ts;
 *                  this skeleton intentionally implements none of it — every
 *                  method below is a no-op so the red spec fails on
 *                  assertions, never on invocation errors):
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
 *                  - Registration in app-service-container.ts (LinkProvider
 *                    pattern: construct with logger + fsal, _informativeBoot,
 *                    _safeShutdown, getter) is green-phase work and lands
 *                    with the implementation of this contract.
 *
 * END HEADER
 */

import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import type FSAL from '../fsal'
import { type WorkspaceReferenceState } from './reference-index'

/**
 * Serves the merged workspace reference view (saved FSAL snapshots overlaid
 * by renderer-reported live buffers) to every consumer over the
 * 'reference-provider' ipc channel.
 */
export default class ReferenceProvider extends ProviderContract {
  constructor (
    private readonly _logger: LogProvider,
    private readonly _fsal: FSAL
  ) {
    super()
    // Phase 3b red skeleton: the 'reference-provider' ipcMain handler is NOT
    // registered yet. test/reference-provider-shell.spec.ts fails on exactly
    // this gap.
  }

  /**
   * Phase 3b red skeleton: does not subscribe to FSAL events yet.
   */
  public async boot (): Promise<void> {
    // No-op until the contract in the header is implemented.
  }

  /**
   * Returns the merged workspace reference state.
   *
   * Phase 3b red skeleton: returns the empty workspace — nothing has been
   * indexed because boot() and the ipc surface are unimplemented.
   *
   * @return  {WorkspaceReferenceState}  The merged workspace reference state
   */
  public getSnapshot (): WorkspaceReferenceState {
    return { snapshots: [], resolutions: new Map() }
  }

  /**
   * Shuts down the service provider.
   */
  public async shutdown (): Promise<void> {
    // Nothing to tear down in the red skeleton.
  }
}

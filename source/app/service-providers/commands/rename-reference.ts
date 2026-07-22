/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RenameReference command
 * CVM-Role:        <none>
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Workspace reference rename orchestration (issue #1,
 *                  Phase 6), following the RenameTag command pattern
 *                  (./rename-tag.ts): one ZettlrCommand class bound to the
 *                  renderer-facing 'application' channel events, delegating
 *                  the actual protocol to the ReferenceProvider
 *                  (this._app.references).
 *
 *                  CONTRACT (the provider half is locked red by
 *                  test/reference-rename-atomicity.spec.ts):
 *
 *                  - 'preview-reference-rename' { oldKey, newKey } returns
 *                    the provider's previewRename() result verbatim: either
 *                    the previewed WorkspaceReferenceEdit or a typed
 *                    rejection (prefix/family violation, collision,
 *                    malformed key, unknown key). No dialog and no write
 *                    happens at preview time.
 *                  - 'commit-reference-rename' { edit } returns the
 *                    provider's commitRename() outcome: hash-fenced atomic
 *                    application (closed files via temp+rename disk writes;
 *                    open-buffer transactions RETURNED for the invoking
 *                    renderer to apply through CodeMirror, keeping those
 *                    buffers dirty/unsaved) or a structured conflict with
 *                    nothing applied anywhere.
 *                  - 'undo-reference-rename' returns the provider's
 *                    undoRename() outcome: the one-shot, hash-fenced
 *                    inverse application restoring every touched document.
 *
 *                  Unlike RenameTag, this command NEVER shows a blocking
 *                  confirmation dialog: the renderer owns the preview UI,
 *                  and recoverable failures surface as typed results the
 *                  renderer presents as closable toasts (issue #1 forbids
 *                  uncloseable runtime-error overlays).
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome
} from '@common/pandoc-util/compute-reference-edits'
import type { WorkspaceReferenceEdit } from '@dts/common/references'

export default class RenameReference extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, [ 'preview-reference-rename', 'commit-reference-rename', 'undo-reference-rename' ])
  }

  /**
   * Runs one of the three rename protocol events by delegating to the
   * ReferenceProvider, whose protocol behavior is locked at the provider
   * boundary by test/reference-rename-atomicity.spec.ts.
   *
   * @param   {string}  evt  One of the three bound rename events
   * @param   {any}     arg  The event payload (see the header contract)
   *
   * @return  {Promise<any>}  The provider's typed outcome, verbatim
   */
  async run (evt: string, arg: any): Promise<ReferenceRenamePreview|CommitRenameOutcome|UndoRenameOutcome> {
    if (evt === 'preview-reference-rename') {
      return this._app.references.previewRename(arg.oldKey as string, arg.newKey as string)
    } else if (evt === 'commit-reference-rename') {
      return await this._app.references.commitRename(arg.edit as WorkspaceReferenceEdit)
    } else {
      return await this._app.references.undoRename()
    }
  }
}

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
 *                    open-buffer transactions applied and acknowledged by
 *                    the central document authority, keeping those buffers
 *                    dirty/unsaved) or a structured conflict with nothing
 *                    applied anywhere.
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

import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome,
} from "@common/pandoc-util/compute-reference-edits";
import type { WorkspaceReferenceEdit } from "@dts/common/references";
import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

type RenameReferenceCommandArgument =
  | { oldKey: string; newKey: string }
  | { edit: WorkspaceReferenceEdit }
  | undefined;

export default class RenameReference extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, ["preview-reference-rename", "commit-reference-rename", "undo-reference-rename"]);
  }

  /**
   * Runs one of the three rename protocol events by delegating to the
   * ReferenceProvider, whose protocol behavior is locked at the provider
   * boundary by test/reference-rename-atomicity.spec.ts.
   *
   * @param   {string}  evt  One of the three bound rename events
   * @param   {RenameReferenceCommandArgument} arg The event payload
   *
   * @return  {Promise<ReferenceRenamePreview|CommitRenameOutcome|UndoRenameOutcome>}
   *   The provider's typed outcome, verbatim
   */
  async run(
    evt: string,
    arg: RenameReferenceCommandArgument,
  ): Promise<ReferenceRenamePreview | CommitRenameOutcome | UndoRenameOutcome> {
    if (evt === "preview-reference-rename") {
      if (arg === undefined || !("oldKey" in arg)) {
        throw new Error("preview-reference-rename requires oldKey and newKey");
      }
      return this._app.references.previewRename(arg.oldKey, arg.newKey);
    } else if (evt === "commit-reference-rename") {
      if (arg === undefined || !("edit" in arg)) {
        throw new Error("commit-reference-rename requires a workspace edit");
      }
      return await this._app.references.commitRename(arg.edit);
    } else {
      return await this._app.references.undoRename();
    }
  }
}

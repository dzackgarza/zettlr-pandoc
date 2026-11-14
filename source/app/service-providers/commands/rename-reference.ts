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
 *                  CONTRACT (test/reference-rename-atomicity.spec.ts):
 *
 *                  - 'preview-reference-rename' { oldKey, newKey } returns
 *                    the provider's previewRename() result: the previewed
 *                    WorkspaceReferenceEdit with each changed line of each
 *                    document (#6) and the id under which the command keeps
 *                    that edit, or a typed rejection (prefix/family
 *                    violation, collision, malformed key, unknown key). No
 *                    write happens at preview time. The command keeps one
 *                    preview: a new preview replaces the one before it.
 *                  - 'commit-reference-rename' { id } commits the kept edit
 *                    of that id through the provider's commitRename():
 *                    hash-fenced atomic application (closed files via
 *                    temp+rename disk writes; open-buffer transactions
 *                    applied and acknowledged by the central document
 *                    authority, keeping those buffers dirty/unsaved) or a
 *                    structured conflict with nothing applied anywhere. The
 *                    window sends no edit, so it commits only a rename that
 *                    the author saw (#57).
 *                  - 'undo-reference-rename' returns the provider's
 *                    undoRename() outcome: the one-shot, hash-fenced
 *                    inverse application restoring every touched document.
 *
 *                  The window shows the preview in the workspace edit
 *                  preview dialog (WorkspaceEditPreviewDialog) and commits
 *                  on Apply; a rejection is a typed result that the window
 *                  shows as a message.
 *
 * END HEADER
 */

import { randomUUID } from "node:crypto";
import { trans } from "@common/i18n-main";
import type {
  CommitRenameOutcome,
  IssuedReferenceRenamePreview,
  UndoRenameOutcome,
} from "@common/pandoc-util/compute-reference-edits";
import type { WorkspaceReferenceEdit } from "@dts/common/references";
import type { AppServiceContainer } from "source/app/app-service-container";
import ZettlrCommand from "./zettlr-command";

export default class RenameReference extends ZettlrCommand<
  Pick<AppServiceContainer, "references">
> {
  /** The edit of the last accepted preview, under the id the window got. */
  private _previewed: { id: string; edit: WorkspaceReferenceEdit } | undefined;

  constructor(app: Pick<AppServiceContainer, "references">) {
    super(app);
    this._previewed = undefined;
  }

  /** Undoes the last rename. */
  async undo(): Promise<UndoRenameOutcome> {
    return await this._app.references.undoRename();
  }

  async preview(arg: { oldKey: string; newKey: string }): Promise<IssuedReferenceRenamePreview> {
    this._previewed = undefined;
    const preview = await this._app.references.previewRename(arg.oldKey, arg.newKey);
    if (preview.status === "rejected") {
      return preview;
    }
    const id = randomUUID();
    this._previewed = { id, edit: preview.edit };
    return { ...preview, id };
  }

  async commit(arg: { id: string }): Promise<CommitRenameOutcome> {
    const previewed = this._previewed;
    if (previewed === undefined || previewed.id !== arg.id) {
      throw new Error(trans("The rename is no longer available. No file changed."));
    }
    this._previewed = undefined;
    return await this._app.references.commitRename(previewed.edit);
  }
}

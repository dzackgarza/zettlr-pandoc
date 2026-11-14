/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        WorkspaceEditCommand command
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The answer of the author to a proposal that the main
 *                  process sent to a window (`CommandProvider.propose`).
 *
 *                  - 'apply-workspace-edit' { id } applies the edits of the
 *                    proposal through the journaled workspace-edit
 *                    transaction. A document that changed after the preview
 *                    refuses the whole edit; a file that cannot be written
 *                    rolls back each document that changed. Both reject, and
 *                    then no file changed. An open document whose save is
 *                    refused keeps the edit in its buffer, and the command
 *                    rejects with its name.
 *                  - 'discard-workspace-edit' { id } drops the proposal.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { app } from "electron";
import type { AppServiceContainer } from "source/app/app-service-container";
import { applyWorkspaceEdit } from "source/app/util/workspace-edit-proposal";
import ZettlrCommand from "./zettlr-command";

export default class WorkspaceEditCommand extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app);
  }

  /** Drops the proposal with the id, which the author did not apply. */
  discard(id: string): void {
    this._app.commands.takeProposal(id);
  }

  /** Applies the proposal with the id; a conflict and an unsaved document reject. */
  async apply(id: string): Promise<boolean> {
    const proposal = this._app.commands.takeProposal(id);
    const outcome = await applyWorkspaceEdit(this._app.documents, app.getPath("userData"), {
      edits: proposal.edits,
      expectedSourceHashes: proposal.expectedSourceHashes,
    });
    if (outcome.status === "conflict") {
      throw new Error(
        trans(
          "No file changed: %s changed after the preview. Do the action again to see its edit.",
          outcome.documentPath,
        ),
      );
    }
    if (outcome.unsaved.length > 0) {
      throw new Error(
        trans(
          "These documents have the edit but could not be saved:\n%s",
          outcome.unsaved
            .map(({ documentPath, refusal }) => `${documentPath}: ${refusal.message}`)
            .join("\n"),
        ),
      );
    }
    this._app.log.info(
      `[Application] ${proposal.title}: changed ${outcome.documentsChanged.join(", ")}`,
    );
    return true;
  }
}

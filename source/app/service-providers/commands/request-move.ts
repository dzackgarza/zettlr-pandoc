/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RequestMove command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command moves a file or directory.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import { runEachStep } from "source/app/util/run-each-step";
import { systemErrorCause } from "source/app/util/system-error-cause";
import { isAtOrInsideRoot } from "source/common/util/renderer-path-polyfill";
import ZettlrCommand from "./zettlr-command";

export default class RequestMove extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "request-move");
  }

  /**
   * Move a directory around. Or a file.
   *
   * @param  {string}   evt  The event name
   * @param  {any}      arg  The origin and the destination
   * @return {boolean}       Whether or not the command succeeded.
   */
  async run(evt: string, arg: { from: string; to: string }): Promise<boolean> {
    // arg contains from and to. Prepare the necessary variables
    const from = await this._app.fsal.getDescriptorFor(arg.from);
    const to = await this._app.fsal.getAnyDirectoryDescriptor(arg.to);

    if (to === undefined || from === undefined) {
      throw new Error(
        `Could not move ${arg.from} to ${arg.to}: ${from === undefined ? "the source" : "the target directory"} was not found.`,
      );
    }

    // It can happen that the user begins to drag a file but then realizes they
    // don't want to move the file, so they will just drop it in the origin
    // directory. Without the following check they would be presented with an
    // unwanted "file already exists in target directory"-message.
    if (to.path === from.dir) {
      return false;
    }

    // Let's check if the destination is a child of the source:
    if (from.type === "directory" && isAtOrInsideRoot(to.path, from.path)) {
      this._app.windows.prompt({
        type: "error",
        title: trans("Cannot move directory"),
        message: trans("You cannot move a directory into one of its subdirectories."),
      });
      return false;
    }

    // Now check if there already is a directory/file with the same name
    const newPath = path.join(to.path, from.name);
    if (await this._app.fsal.pathExists(newPath)) {
      this._app.windows.prompt({
        type: "error",
        title: trans("Cannot move directory or file"),
        message: trans("The file/directory %s already exists in target.", from.name),
      });

      return false;
    }

    // A final check: If from is a file, and the file is modified, we cannot
    // move, lest we want to induce data loss, see issue #2347
    if (this._app.documents.isModified(arg.from)) {
      throw new Error(
        trans("Cannot move %s: it has unsaved changes. Save the file, then move it.", from.name),
      );
    }

    // Now we can move the source to the target.
    const linksBefore = this._app.links.snapshot();
    await this._app.fsal.rename(from.path, newPath).catch((failure: NodeJS.ErrnoException) => {
      throw new Error(
        trans("Could not move %s to %s: %s.", from.name, to.name, systemErrorCause(failure)),
        { cause: failure },
      );
    });

    // The source is at its new place. Each step that follows runs, also when
    // the step before it failed: the links follow a document whose
    // collaboration state could not.
    const move = { from: from.path, to: newPath };
    await runEachStep([
      // Notify the documents provider so it can exchange any files if necessary
      async () => {
        if (await this._app.fsal.isFile(newPath)) {
          await this._app.documents.hasMovedFile(from.path, newPath);
        } else {
          await this._app.documents.hasMovedDir(from.path, newPath);
        }
      },
      // Offer the edit that keeps each link naming the file it named before the move
      async () => {
        const proposal = await this._app.links.retargetProposal(
          linksBefore,
          move,
          this._app.documents,
        );
        if (proposal !== undefined) {
          this._app.commands.propose(proposal);
        }
      },
    ]);

    return true;
  }
}

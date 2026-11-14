/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DirRename command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command renames a directory.
 *
 * END HEADER
 */

import path from "path";
import sanitize from "sanitize-filename";
import type { AppServiceContainer } from "source/app/app-service-container";
import { runEachStep } from "source/app/util/run-each-step";
import { systemErrorCause } from "source/app/util/system-error-cause";
import { trans } from "source/common/i18n-main";
import ZettlrCommand from "./zettlr-command";

export default class DirRename extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "dir-rename");
  }

  /**
   * Rename a directory
   *
   * @param  {string}  evt The event name
   * @param  {any}     arg An object with the path for the source dir and the new directory name.
   */
  async run(evt: string, arg: { path: string; name: string }): Promise<boolean> {
    const sourceDir = await this._app.fsal.getAnyDirectoryDescriptor(arg.path);
    if (sourceDir === undefined) {
      throw new Error(`Could not rename the directory: ${arg.path} is not a loaded directory.`);
    }

    const sanitizedName = sanitize(arg.name, { replacement: "-" });
    const newPath = path.join(path.dirname(arg.path), sanitizedName);

    // At this point no file is open in that directory anymore, so we can easily
    // rename the directory. The FSAL will reflect the changes.
    return await this._rename(arg.path, newPath).then(
      () => true,
      (failure: Error) => {
        // The command shows the cause itself, so it answers its contract and
        // does not throw as well.
        this._app.log.error(`Error during renaming directory: ${failure.message}`, failure);
        this._app.windows.prompt({
          type: "error",
          title: trans("Rename directory"),
          message: failure.message,
        });
        return false;
      },
    );
  }

  private async _rename(sourcePath: string, newPath: string): Promise<void> {
    // Before renaming the dir, let's see if it is a workspace. Because if it
    // is, we have to close it first.
    const { openWorkspaces } = this._app.config.getConfig().app;
    const isRoot = openWorkspaces.includes(sourcePath);

    const linksBefore = this._app.links.snapshot();

    if (isRoot) {
      this._app.config.removePath(sourcePath);
    }

    // The workspace follows the directory: to its new path, or back to its
    // old path when the rename failed. A later failure leaves it open.
    const renamed = this._app.fsal
      .rename(sourcePath, newPath)
      .catch((failure: NodeJS.ErrnoException) => {
        throw new Error(
          trans("Could not rename %s: %s.", path.basename(sourcePath), systemErrorCause(failure)),
          { cause: failure },
        );
      });
    if (isRoot) {
      await renamed.then(
        () => this._app.config.addPath(newPath),
        () => this._app.config.addPath(sourcePath),
      );
    }
    await renamed;

    // The directory has its new name. Each step that follows runs, also when
    // the step before it failed: the links follow a document whose
    // collaboration state could not.
    const move = { from: sourcePath, to: newPath };
    await runEachStep([
      // Notify the documents provider so it can exchange any files if necessary
      async () => await this._app.documents.hasMovedDir(sourcePath, newPath),
      // Offer the edit that keeps each link naming the file it named before the rename
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
  }
}

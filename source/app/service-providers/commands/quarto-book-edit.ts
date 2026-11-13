import type { ProjectSettings } from "@dts/common/fsal";
import type { AppServiceContainer } from "source/app/app-service-container";
import { editQuartoBookManifest, type QuartoBookEdit } from "source/app/util/quarto-book-editor";
import { trans } from "source/common/i18n-main";
import ZettlrCommand from "./zettlr-command";

export interface QuartoBookEditRequest {
  rootPath: string;
  edit: QuartoBookEdit;
}

/** Edits the Quarto book file and returns the refreshed project settings. */
export default class QuartoBookEditCommand extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "quarto-book-edit");
  }

  async run(_evt: string, arg: QuartoBookEditRequest): Promise<ProjectSettings> {
    const dir = await this._app.fsal.getAnyDirectoryDescriptor(arg.rootPath);
    if (dir === undefined) {
      throw new Error(`Can't edit the Quarto book because ${arg.rootPath} is not open`);
    }
    const project = dir.settings.project;
    if (project?.manifest.kind !== "quarto") {
      throw new Error(`${arg.rootPath} is not a Quarto book project`);
    }

    // The edit reads the manifest from disk. Unsaved text of the manifest in
    // an editor is text of the author that the edit would not hold, and a
    // later save of that text would undo the edit.
    if (this._app.documents.isModified(project.manifest.path)) {
      throw new Error(
        trans(
          "The Quarto book file %s has unsaved changes in an editor. Save or discard them, then change the book again.",
          project.manifest.path,
        ),
      );
    }
    await editQuartoBookManifest(dir.path, project.manifest.path, arg.edit);
    await this._app.fsal.refreshQuartoProject(dir);

    const refreshed = dir.settings.project;
    if (refreshed?.manifest.kind !== "quarto") {
      const problem = dir.metadataProblems.find((candidate) => candidate.source === "manifest");
      throw new Error(
        problem === undefined
          ? trans("The Quarto book file of %s no longer describes a book.", dir.path)
          : trans(
              "The Quarto book file %s could not be used after the change: %s",
              problem.path,
              problem.message,
            ),
      );
    }
    return refreshed;
  }
}

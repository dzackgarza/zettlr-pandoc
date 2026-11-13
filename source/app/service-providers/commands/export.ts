/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command exports a single file.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { PANDOC_WRITERS } from "@common/pandoc-util/pandoc-maps";
import { showNativeNotification } from "@common/util/show-notification";
import type AssetsProvider from "@providers/assets";
import { type ValidPandocProfile } from "@providers/assets";
import type ConfigProvider from "@providers/config";
import type DocumentManager from "@providers/documents";
import type FSAL from "@providers/fsal";
import type LinkProvider from "@providers/links";
import type LogProvider from "@providers/log";
import type LongRunningTaskProvider from "@providers/long-running-tasks";
import type WindowProvider from "@providers/windows";
import { app as electronApp } from "electron";
import { promises as fs } from "fs";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import { openPath, revealPath } from "source/app/util/open-path";
import { makeExport } from "./exporter";
import { runShellCommand } from "./exporter/run-shell-command";
import type { ExporterOptions } from "./exporter/types";
import ZettlrCommand from "./zettlr-command";

/**
 * Reads the `zettlr.pandoc_working_dir` override out of a file's frontmatter.
 * The frontmatter holds whatever YAML the user wrote, so every step down to the
 * value is checked.
 *
 * @param   {unknown}          frontmatter  The file's parsed frontmatter
 *
 * @return  {string|undefined}              The declared directory, if any
 */
function frontmatterWorkingDir(frontmatter: unknown): string | undefined {
  if (!(frontmatter instanceof Object) || !("zettlr" in frontmatter)) {
    return undefined;
  }

  const { zettlr } = frontmatter;
  if (!(zettlr instanceof Object) || !("pandoc_working_dir" in zettlr)) {
    return undefined;
  }

  const workingDir = zettlr.pandoc_working_dir;
  return typeof workingDir === "string" ? workingDir : undefined;
}

export interface CustomExportIPCAPI {
  displayName: string;
  file: string;
}

export interface ExportIPCAPI {
  file: string;
  profile: ValidPandocProfile;
  exportTo: string;
}

export default class Export extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, ["export", "custom-export"]);
  }

  /**
   * Exports a single file to another format.
   *
   * @param  {string} evt The event name
   * @param  {Object} arg An object containing hash and wanted extension.
   * @return {Boolean}     Whether or not the call succeeded.
   */
  async run(evt: string, arg: CustomExportIPCAPI | ExportIPCAPI): Promise<void> {
    // Custom export
    if (evt === "custom-export") {
      if (!("displayName" in arg)) {
        throw new Error("Unexpected payload received for custom-export event.");
      }

      const { displayName, file } = arg;

      const commands = this._app.config.get().export.customCommands;
      const foundCommand = commands.find((c) => c.displayName === displayName);
      if (foundCommand === undefined) {
        throw new Error(`Cannot run custom command ${displayName}: Not found`);
      }

      this._app.log.info(
        `[Export] Running custom export command ${displayName} on file ${file} ...`,
      );
      const task = this._app.lrt.registerTask(
        trans('Exporting file "%s"', path.basename(file)),
        trans("Exporting using custom command %s", displayName),
      );
      const cwd = path.dirname(file);

      try {
        const output = await runShellCommand(foundCommand.command, [file], cwd);

        if (output.code !== 0) {
          this._app.log.error(
            `[Export] Custom export ${displayName} failed with code ${output.code}`,
            output.stderr,
          );
          const title = trans("Export failed");
          const message = trans(
            "An error occurred during export: %s",
            `Custom Command exited with code ${output.code}`,
          );
          this._app.windows.showErrorMessage(title, message, output.stderr);
          task.endTask("error", new Error(message));
        } else {
          this._app.log.info(`[Export] File ${path.basename(file)} exported successfully.`);
          task.update({ info: trans("Exported file successfully.") });
          task.endTask("success");
        }

        if (output.stdout.length > 0) {
          this._app.log.info("This custom export run produced additional output.", output.stdout);
        }
      } catch (err: unknown) {
        if (!(err instanceof Error)) {
          this._app.log.error(
            `[Export] Custom export ${displayName} failed with an unknown error`,
            err,
          );
          task.endTask("error", new Error("Unknown error"));
        } else {
          this._app.log.error(
            `[Export] Custom export ${displayName} failed with an error: ${err.message}`,
            err,
          );
          task.endTask("error", err);
        }
      }
      return; // Done
    }

    // Regular export
    if (!("profile" in arg) || !("exportTo" in arg)) {
      throw new Error("Unexpected payload received for export event.");
    }
    await exportDocument(this._app, arg);
  }
}

/** The services of the application that the export of one document uses. */
export interface DocumentExportServices {
  documents: Pick<DocumentManager, "isModified" | "getDocument">;
  fsal: Pick<FSAL, "getDescriptorForAnySupportedFile" | "isDir" | "getAnyDirectoryDescriptor">;
  windows: Pick<WindowProvider, "askDir" | "showErrorMessage">;
  lrt: LongRunningTaskProvider;
  config: ConfigProvider;
  assets: AssetsProvider;
  log: LogProvider;
  links: Pick<LinkProvider, "index">;
}

/**
 * Exports one document with one profile.
 *
 * @param   {DocumentExportServices}  app  The services of the application
 * @param   {ExportIPCAPI}            arg  The document, the profile and the destination
 */
export async function exportDocument(
  app: DocumentExportServices,
  arg: ExportIPCAPI,
): Promise<void> {
  const { file, profile, exportTo } = arg;

  // We must have an absolute path given in file
  const fileDescriptor = await app.fsal.getDescriptorForAnySupportedFile(file);

  // The export runs in the folder of the document. A document can name
  // another folder in its front matter (zettlr.pandoc_working_dir), as an
  // absolute path or as a path from its own folder.
  let cwd = fileDescriptor.dir;
  const declaredWorkingDir =
    fileDescriptor.type === "file" ? frontmatterWorkingDir(fileDescriptor.frontmatter) : undefined;
  if (declaredWorkingDir !== undefined) {
    cwd = path.resolve(fileDescriptor.dir, declaredWorkingDir);
    if (!(await app.fsal.isDir(cwd))) {
      app.windows.showErrorMessage(
        trans("Export error"),
        trans(
          "%s declares the working directory %s, which is no folder. The document was not exported.",
          fileDescriptor.name,
          cwd,
        ),
      );
      return;
    }
  }

  let targetDirectory = fileDescriptor.dir;
  switch (exportTo) {
    case "ask": {
      const folderSelection = await app.windows.askDir(
        trans("Choose export destination"),
        null,
        trans("Save"),
      );
      // The author cancelled the dialog: a choice, and no failure.
      if (folderSelection.length === 0) {
        return;
      }
      targetDirectory = folderSelection[0];
      break;
    }
    case "temp":
      targetDirectory = electronApp.getPath("temp");
      break;
    case "cwd":
    default:
      break;
  }

  const { path: documentPath, name, ext } = fileDescriptor;
  const exportOf = (textFile: string): ExporterOptions => {
    return {
      profile,
      targetDirectory,
      sourceFiles: [{ path: documentPath, name, ext, textFile }],
      cwd,
    };
  };

  if (!app.documents.isModified(file)) {
    await runDocumentExport(app, arg, exportOf(documentPath));
    return;
  }

  // The document has unsaved text. The export is of that text, as the
  // document that it is: its path, its folder and its resources stay. The
  // text goes to a file in a directory of this export, which the export
  // removes.
  const scratch = await fs.mkdtemp(path.join(electronApp.getPath("temp"), "zettlr-export-"));
  const textFile = path.join(scratch, name);
  await app.documents
    .getDocument(file)
    .then(async (unsaved) => {
      await fs.writeFile(textFile, unsaved.content, { encoding: "utf8" });
      await runDocumentExport(app, arg, exportOf(textFile));
    })
    .finally(async () => {
      await fs.rm(scratch, { recursive: true });
    });
}

/**
 * Runs the export of one document and tells the author its result.
 *
 * @param   {DocumentExportServices}  app              The services of the application
 * @param   {ExportIPCAPI}            arg              The document and the profile
 * @param   {ExporterOptions}         exporterOptions  What the exporter gets
 */
async function runDocumentExport(
  app: DocumentExportServices,
  arg: ExportIPCAPI,
  exporterOptions: ExporterOptions,
): Promise<void> {
  const { file, profile } = arg;

  const task = app.lrt.registerTask(
    trans("Exporting file %s", path.basename(file)),
    trans("Exporting using profile %s", profile.name),
  );

  // Call the exporter. Don't throw the "big" error as this is single-file export
  try {
    app.log.verbose(
      `[Exporter] Exporting ${exporterOptions.sourceFiles.length} files to ${exporterOptions.targetDirectory}`,
    );
    const output = await makeExport(
      exporterOptions,
      app.log,
      app.config,
      app.assets,
      app.links.index,
      app.fsal,
    );
    if (output.code === 0) {
      app.log.info(`Successfully exported file to ${output.targetFile}`);
      const readableFormat =
        profile.writer in PANDOC_WRITERS ? PANDOC_WRITERS[profile.writer] : profile.writer;
      showNativeNotification(trans("Exported to %s", readableFormat));
      // The export is done when the file is written. An open of the file
      // that the desktop refuses is a message of its own, and the command
      // does not wait for the application that shows the file.
      const openExportedFile = (): void => {
        openPath(output.targetFile).catch((refusal: Error) => {
          app.log.error(refusal.message, refusal);
          app.windows.showErrorMessage(trans("Could not open the exported file"), refusal.message);
        });
      };
      task.update({
        title: trans("File %s has been exported", path.basename(file)),
        info: trans("File has been exported to %s", readableFormat),
        successInteraction: openExportedFile,
      });
      task.endTask("success");

      // A textbundle is a folder and a textpack an archive: the file browser
      // shows them, as no application opens them.
      if (app.config.get().export.autoOpenExportedFiles) {
        if (["textbundle", "textpack"].includes(profile.writer)) {
          revealPath(output.targetFile).catch((refusal: Error) => {
            app.log.error(refusal.message, refusal);
            app.windows.showErrorMessage(
              trans("Could not open the exported file"),
              refusal.message,
            );
          });
        } else {
          openExportedFile();
        }
      }
    } else {
      const title = trans("Export failed");
      const message = trans(
        "An error occurred on export: %s",
        `Pandoc exited with code ${output.code}`,
      );
      const contents = output.stderr.join("\n");
      app.windows.showErrorMessage(title, message, contents);
      task.endTask("error", new Error(`Export failed with status ${output.code}`));
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      const message: string = err.message;
      app.windows.showErrorMessage(trans("Export error"), message);
      app.log.error(message, err);
      task.endTask("error", err);
    } else {
      app.log.error("Export failed with an unknown error.", err);
      task.endTask("error", new Error("Unknown error"));
    }
  }
}

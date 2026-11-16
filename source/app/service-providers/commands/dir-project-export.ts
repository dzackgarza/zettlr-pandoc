/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DirProjectExport command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command exports a directory as project.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { showNativeNotification } from "@common/util/show-notification";
import type LogProvider from "@providers/log";
import { dialog } from "electron";
import { stat } from "fs/promises";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import { openPath } from "source/app/util/open-path";
import { isHtmlWriter, isTexWriter, PANDOC_WRITERS } from "source/common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "source/common/pandoc-util/parse-reader-writer";
import type { DirDescriptor, ProjectSettings } from "source/types/common/fsal";
import type AssetsProvider from "../assets";
import type ConfigProvider from "../config";
import type FSAL from "../fsal";
import type LinkProvider from "../links";
import type LongRunningTaskProvider from "../long-running-tasks";
import type WindowProvider from "../windows";
import { makeExport } from "./exporter";
import {
  type ExportItem,
  type ExportItemEntry,
  exportItemKind,
  exportItemOfProjectEntry,
} from "./exporter/export-items";
import type { ExporterOptions } from "./exporter/types";
import ZettlrCommand from "./zettlr-command";

/**
 * Converts a path fragment to use Windows path separators by replacing / with \
 *
 * @param   {string}  pathFragment  The path fragment
 *
 * @return  {string}                The path fragment using Windows conventions.
 */
function pathToWin(pathFragment: string): string {
  return pathFragment.replace(/\//g, "\\");
}

export default class DirProjectExport extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app);
  }

  /**
   * Exports the current project.
   * @param {String} evt The event name
   * @param  {Object} arg The hash of a directory.
   */
  async run(evt: string, arg: string): Promise<boolean> {
    return await exportProject(this._app, arg);
  }
}

/** The services of the application that a Project export uses. */
export interface ProjectExportServices {
  fsal: FSAL;
  assets: AssetsProvider;
  config: ConfigProvider;
  log: LogProvider;
  lrt: LongRunningTaskProvider;
  links: Pick<LinkProvider, "index">;
  windows: Pick<WindowProvider, "showErrorMessage">;
}

/**
 * Exports a Project with each profile of its settings.
 *
 * @param   {ProjectExportServices}  app  The services of the application
 * @param   {string}                 arg  The path of the Project folder
 *
 * @return  {Promise<boolean>}            Whether each profile exported
 */
export async function exportProject(app: ProjectExportServices, arg: string): Promise<boolean> {
  // First get the directory
  const dir = await app.fsal.getAnyDirectoryDescriptor(arg);

  if (dir === undefined) {
    throw new Error(`Could not export the project: ${arg} is not a loaded directory.`);
  }

  const config = dir.settings.project;

  if (config === null) {
    throw new Error(`Could not export the project: ${dir.name} is not a project.`);
  }

  // The export takes each chapter of the settings that is a file on disk.
  // The file filters decide what the file manager lists, not which files a
  // Project holds (§10). The author gets a message that names each other
  // chapter with its cause.
  const chapters = await Promise.all(
    config.files.map(async (file) => {
      // The settings hold Unix paths relative to the Project folder.
      const absPath = path.join(dir.path, process.platform === "win32" ? pathToWin(file) : file);
      const problem = await stat(absPath).then(
        (stats) => (stats.isFile() ? undefined : `${file}: ${absPath} is not a file`),
        (error: NodeJS.ErrnoException) => `${file}: ${error.message}`,
      );
      return { absPath, problem };
    }),
  );
  const existingFilesWithSorting = chapters
    .filter((chapter) => chapter.problem === undefined)
    .map((chapter) => chapter.absPath);
  const missingChapters = chapters.flatMap((chapter) =>
    chapter.problem === undefined ? [] : [chapter.problem],
  );

  if (existingFilesWithSorting.length === 0) {
    app.log.warning("[Project] Aborting project export: No files to export");
    dialog.showErrorBox(
      trans("Cannot export project"),
      trans(
        "There are no files selected for export. Please select files to be included in the project settings.",
      ),
    );
    return false; // Cannot export
  } else if (missingChapters.length > 0) {
    await dialog.showMessageBox({
      title: trans("Project File Mismatch"),
      message: trans(
        "One or more files of the project settings are not on disk or cannot be read. The export leaves them out.",
      ),
      detail: missingChapters.join("\n"),
      buttons: [trans("Ok")],
    }); // Don't return, because we still can export
  }

  const items = await app.assets.listExportItems();

  // One exporter that stops does not stop the other ones. The author gets
  // one message for the whole export.
  const failed: FailedExporter[] = [];
  const withTexErrors: ExporterWithTexErrors[] = [];
  for (const entry of config.profiles) {
    const item = exportItemOfProjectEntry(entry, items);
    const name = item === undefined ? entry : item.id;
    try {
      const texErrors = await exportWith(app, dir, config, existingFilesWithSorting, item);
      if (texErrors.length > 0) {
        app.log.warning(
          `[Project] ${config.title} exported with ${name}, and TeX reported errors`,
          texErrors,
        );
        withTexErrors.push({ name, errors: texErrors });
      }
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      app.log.error(`[Project] ${config.title} did not export with ${name}: ${cause}`, err);
      failed.push({ name, cause });
    }
  }

  if (failed.length > 0) {
    const names = failed.map((exporter) => exporter.name).join(", ");
    app.windows.showErrorMessage(
      trans("Export error"),
      failed.length === config.profiles.length
        ? trans('Could not export the Project "%s" with %s.', config.title, names)
        : trans(
            'Could not export the Project "%s" with %s. The other profiles exported.',
            config.title,
            names,
          ),
      [
        ...failed.map((exporter) => `${exporter.name}\n${exporter.cause}`),
        ...withTexErrors.map(
          (exporter) =>
            `${trans("%s: exported with TeX errors", exporter.name)}\n${exporter.errors.join("\n")}`,
        ),
      ].join("\n\n"),
    );
    return false;
  }

  if (withTexErrors.length > 0) {
    // Each profile exported. The recipe wrote a PDF of chapters with a TeX
    // error: the author gets the errors, and no message that reads as an
    // export without a fault.
    app.windows.showErrorMessage(
      trans("The PDF has TeX errors"),
      trans(
        'TeX reported errors for the Project "%s" with %s. Each profile exported, and a PDF with errors can lack text. A line number is a line of the TeX file that the recipe built.',
        config.title,
        withTexErrors.map((exporter) => exporter.name).join(", "),
      ),
      withTexErrors
        .map((exporter) => `${exporter.name}\n${exporter.errors.join("\n")}`)
        .join("\n\n"),
    );
    return true;
  }

  const notificationShown = await showNativeNotification(
    trans('Project "%s" successfully exported. Click to show.', config.title),
    trans("Project Export"),
    () => {
      openShowingRefusal(app, dir.path);
    },
  );

  if (!notificationShown) {
    openShowingRefusal(app, dir.path);
  }

  return true;
}

/** An exporter of a Project that did not export, and why. */
interface FailedExporter {
  name: string;
  cause: string;
}

/** An exporter of a Project that wrote a PDF for which TeX reported errors. */
interface ExporterWithTexErrors {
  name: string;
  errors: string[];
}

/**
 * Exports a Project with one export item. It rejects with the cause when the
 * item did not export.
 *
 * @param   {AppServiceContainer}        app     The ASC
 * @param   {DirDescriptor}              dir     The Project folder
 * @param   {ProjectSettings}            config  The Project settings
 * @param   {string[]}                   files   The files of the Project, in order
 * @param   {ExportItemEntry|undefined}  item    The item that the entry of the
 *                                               Project names, if one has the name
 *
 * @return  {Promise<string[]>}                  The errors that TeX reported for
 *                                               a PDF that the item still wrote;
 *                                               empty without such an error
 */
async function exportWith(
  app: ProjectExportServices,
  dir: DirDescriptor,
  config: ProjectSettings,
  files: string[],
  item: ExportItemEntry | undefined,
): Promise<string[]> {
  if (item === undefined) {
    throw new Error(trans("No profile and no export command has this name."));
  }
  if (item.isInvalid) {
    throw new Error(item.reason);
  }
  return await exportUsingItem(app, dir, config, files, item);
}

/**
 * Exports a Project with an item that can run.
 *
 * @param   {AppServiceContainer}  app     The ASC
 * @param   {DirDescriptor}        dir     The directory
 * @param   {ProjectSettings}      config  The project settings
 * @param   {string[]}             files   The files of the Project, in order
 * @param   {ExportItem}           item    The export item
 *
 * @return  {Promise<string[]>}            The errors that TeX reported for the
 *                                         PDF of the export; empty without
 *                                         such an error
 */
async function exportUsingItem(
  app: ProjectExportServices,
  dir: DirDescriptor,
  config: ProjectSettings,
  files: string[],
  item: ExportItem,
): Promise<string[]> {
  const isCommand = item.engine.kind === "command";
  const task = app.lrt.registerTask(
    trans('Exporting project "%s"', config.title),
    isCommand
      ? trans("Exporting using custom command %s", item.id)
      : trans("Exporting using profile %s", item.id),
  );
  const stop = (err: Error): never => {
    task.update({
      title: trans('Could not export project "%s".', config.title),
      info: isCommand
        ? trans("Export with command %s was unsuccessful: %s.", item.id, err.message)
        : trans("Export with profile %s was unsuccessful: %s.", item.id, err.message),
    });
    task.endTask("error", err);
    throw err;
  };

  const sourceFiles = files.map((file) => {
    return { path: file, name: path.basename(file), ext: path.extname(file), textFile: file };
  });

  const opt: ExporterOptions = {
    item,
    sourceFiles,
    targetDirectory: dir.path,
    cwd: dir.path,
    // A command gets the folder of the Project and runs in it.
    commandSubject: { argument: dir.path, cwd: dir.path },
    defaultsOverride: {
      title: config.title,
      csl:
        typeof config.cslStyle === "string" && config.cslStyle.length > 0
          ? config.cslStyle
          : undefined,
      template: templateOf(config, item),
    },
  };

  app.log.info(`[Project] Exporting ${config.title} using ${item.id}.`);
  const result = await makeExport(
    opt,
    app.log,
    app.config,
    app.assets,
    app.links.index,
    app.fsal,
  ).catch(stop);
  if (result.code !== 0) {
    stop(
      new Error(
        `${
          isCommand
            ? trans("The command ended with the exit code %s.", result.code)
            : trans("The export ended with the exit code %s.", result.code)
        }\n${result.stderr.join("\n").trim()}`,
      ),
    );
  }

  const { targetFile } = result;
  if (targetFile === null) {
    // A command decides what it writes: the export names no file to open.
    task.endTask("success");
    return [];
  }

  const kind = exportItemKind(item);
  const readableFormat = kind in PANDOC_WRITERS ? PANDOC_WRITERS[kind] : kind;
  task.update({
    title:
      result.texErrors.length > 0
        ? trans('Project "%s" has been exported with TeX errors.', config.title)
        : trans('Project "%s" has been exported.', config.title),
    info: trans("Project has been exported to %s.", readableFormat),
    successInteraction: () => {
      openShowingRefusal(app, targetFile);
    },
  });
  task.endTask("success");
  return result.texErrors;
}

/**
 * The template of a Project for an export with an item. The LaTeX template
 * is for each export that goes through TeX: the TeX writers of Pandoc and
 * the PDF recipe. The HTML template is for the HTML writers of Pandoc. These
 * are the families of the settings `export.latexTemplate` and
 * `export.htmlTemplate`.
 *
 * @param   {ProjectSettings}  config  The Project settings
 * @param   {ExportItem}       item    The export item
 *
 * @return  {string|undefined}         The template, or undefined when the
 *                                     Project sets none for the item
 */
function templateOf(config: ProjectSettings, item: ExportItem): string | undefined {
  const { engine } = item;
  const goesThroughTex =
    engine.kind === "recipe" ||
    (engine.kind === "pandoc" && isTexWriter(parseReaderWriter(engine.writer).name));
  if (goesThroughTex && config.templates.tex !== "") {
    return config.templates.tex;
  }
  if (
    engine.kind === "pandoc" &&
    isHtmlWriter(parseReaderWriter(engine.writer).name) &&
    config.templates.html !== ""
  ) {
    return config.templates.html;
  }
  return undefined;
}

/**
 * Opens an export or the Project folder with the application of the desktop.
 * The export does not wait for that application; a refusal is a message of
 * its own.
 */
function openShowingRefusal(
  app: Pick<ProjectExportServices, "log" | "windows">,
  target: string,
): void {
  openPath(target).catch((refusal: Error) => {
    app.log.error(refusal.message, refusal);
    app.windows.showErrorMessage(trans("Could not open the export"), refusal.message);
  });
}

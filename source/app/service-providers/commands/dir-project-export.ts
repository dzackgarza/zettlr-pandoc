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
import { dialog, shell } from "electron";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import { isHtmlWriter, isTexWriter, PANDOC_WRITERS } from "source/common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "source/common/pandoc-util/parse-reader-writer";
import type { DirDescriptor, ProjectSettings } from "source/types/common/fsal";
import type AssetsProvider from "../assets";
import type { PandocProfileMetadata, ValidPandocProfile } from "../assets";
import type ConfigProvider from "../config";
import type { ConfigOptions } from "../config/get-config-template";
import type FSAL from "../fsal";
import type LinkProvider from "../links";
import type LongRunningTaskProvider from "../long-running-tasks";
import type WindowProvider from "../windows";
import { getCustomProfiles, makeExport } from "./exporter";
import { runShellCommand } from "./exporter/run-shell-command";
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
    super(app, "dir-project-export");
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

  // Now, we have to retrieve the files. We have a directory descriptor that
  // contains a list of existing files on disk, and we have a project config
  // that specifies files and a sorting for export. We need to check that all
  // files specified in the config still exist. If a file is missing, display
  // a warning but export anyway.
  const availableFiles = await app.fsal.readDirectoryRecursively(dir.path);

  // Since the config.files array already includes relative paths, we
  // basically just have to make them absolute relative to the directory and
  // ensure those paths exist in availableFiles.
  const existingFilesWithSorting = config.files
    // Since we default to always using Unix paths, to make the magic work on
    // Windows, we here have to map the relative paths in the project config
    // (back) to the Windows conventions by replacing / with \\.
    .map((file) => (process.platform === "win32" ? pathToWin(file) : file))
    .map((file) => path.join(dir.path, file))
    .filter((file) => availableFiles.includes(file));

  if (existingFilesWithSorting.length === 0) {
    app.log.warning("[Project] Aborting project export: No files to export");
    dialog.showErrorBox(
      trans("Cannot export project"),
      trans(
        "There are no files selected for export. Please select files to be included in the project settings.",
      ),
    );
    return false; // Cannot export
  } else if (existingFilesWithSorting.length !== config.files.length) {
    await dialog.showMessageBox({
      title: trans("Project File Mismatch"),
      message: trans(
        "One or more files specified in the project settings have not been found. They may have moved or been deleted. Please verify that all files that you would like to export are included.",
      ),
      buttons: [trans("Ok")],
    }); // Don't return, because we still can export
  }

  // We have to fetch both the regular as well as the custom defaults profiles.
  const regularDefaults = await app.assets.listDefaults();
  const customDefaults = getCustomProfiles(app.config.get().export.scripts);
  const profiles = regularDefaults.concat(customDefaults);
  const commands = app.config.get().export.customCommands;

  // One exporter that stops does not stop the other ones. The author gets
  // one message for the whole export.
  const failed: FailedExporter[] = [];
  for (const entry of config.profiles) {
    const exporter = exporterOf(entry, commands, profiles);
    await exportWith(app, dir, config, existingFilesWithSorting, exporter).catch((err: Error) => {
      app.log.error(
        `[Project] ${config.title} did not export with ${exporter.name}: ${err.message}`,
        err,
      );
      failed.push({ name: exporter.name, cause: err.message });
    });
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
      failed.map((exporter) => `${exporter.name}\n${exporter.cause}`).join("\n\n"),
    );
    return false;
  }

  const notificationShown = showNativeNotification(
    trans('Project "%s" successfully exported. Click to show.', config.title),
    trans("Project Export"),
    () => {
      openDirectory(app.log, dir.path);
    },
  );

  if (!notificationShown) {
    openDirectory(app.log, dir.path);
  }

  return true;
}

/** An export command of the configuration. */
type CustomCommand = ConfigOptions["export"]["customCommands"][number];

/**
 * What one entry of the profile list of a Project exports with. The author
 * knows it by `name`.
 */
type ProjectExporter =
  | { kind: "command"; name: string; command: CustomCommand }
  | { kind: "profile"; name: string; profile: PandocProfileMetadata }
  | { kind: "absent"; name: string };

/** An exporter of a Project that did not export, and why. */
interface FailedExporter {
  name: string;
  cause: string;
}

/**
 * Finds the exporter of one entry of the profile list of a Project. An entry
 * is the command line of an export command or the name of a profile.
 */
function exporterOf(
  entry: string,
  commands: CustomCommand[],
  profiles: PandocProfileMetadata[],
): ProjectExporter {
  const command = commands.find((candidate) => candidate.command === entry);
  if (command !== undefined) {
    return { kind: "command", name: command.displayName, command };
  }
  const profile = profiles.find((candidate) => candidate.name === entry);
  if (profile !== undefined) {
    return { kind: "profile", name: profile.name, profile };
  }
  return { kind: "absent", name: entry };
}

/**
 * Exports a Project with one exporter. It rejects with the cause when the
 * exporter did not export.
 *
 * @param   {AppServiceContainer}  app       The ASC
 * @param   {DirDescriptor}        dir       The Project folder
 * @param   {ProjectSettings}      config    The Project settings
 * @param   {string[]}             files     The files of the Project, in order
 * @param   {ProjectExporter}      exporter  The exporter
 */
async function exportWith(
  app: ProjectExportServices,
  dir: DirDescriptor,
  config: ProjectSettings,
  files: string[],
  exporter: ProjectExporter,
): Promise<void> {
  if (exporter.kind === "absent") {
    throw new Error(trans("No profile and no export command has this name."));
  }
  if (exporter.kind === "command") {
    await exportUsingCustomCommand(app, dir, config, exporter.command);
    return;
  }
  if (exporter.profile.isInvalid) {
    throw new Error(exporter.profile.reason);
  }
  await exportUsingProfile(app, dir, config, files, exporter.profile);
}

/**
 * Exports a given project using a custom command.
 *
 * @param   {AppServiceContainer}  app      The ASC
 * @param   {DirDescriptor}        dir      The directory
 * @param   {ProjectSettings}      config   The project settings
 * @param   {CustomCommand}        command  The command
 */
async function exportUsingCustomCommand(
  app: ProjectExportServices,
  dir: DirDescriptor,
  config: ProjectSettings,
  command: CustomCommand,
): Promise<void> {
  const task = app.lrt.registerTask(
    trans('Exporting project "%s"', config.title),
    trans("Exporting using custom command %s", command.displayName),
  );
  const stop = (err: Error): never => {
    task.update({
      title: trans('Could not export project "%s".', config.title),
      info: trans("Export with command %s was unsuccessful: %s.", command.displayName, err.message),
    });
    task.endTask("error", err);
    throw err;
  };

  app.log.info(`[Project] Exporting ${config.title} using custom command ${command.displayName}.`);
  const output = await runShellCommand(command.command, [`'${dir.path}'`], dir.path).catch(stop);
  if (output.code !== 0) {
    stop(
      new Error(
        `${trans("The command ended with the exit code %s.", output.code)}\n${output.stderr.trim()}`,
      ),
    );
  }
  task.endTask("success");
}

/**
 * Exports a project using a profile.
 *
 * @param   {AppServiceContainer}    app      The ASC
 * @param   {DirDescriptor}          dir      The directory
 * @param   {ProjectSettings}        config   The project settings
 * @param   {string[]}               files    The files of the Project, in order
 * @param   {ValidPandocProfile}     profile  The profile
 */
async function exportUsingProfile(
  app: ProjectExportServices,
  dir: DirDescriptor,
  config: ProjectSettings,
  files: string[],
  profile: ValidPandocProfile,
): Promise<void> {
  const task = app.lrt.registerTask(
    trans('Exporting project "%s"', config.title),
    trans("Exporting using profile %s", profile.name),
  );
  const stop = (err: Error): never => {
    task.update({
      title: trans('Could not export project "%s".', config.title),
      info: trans("Export with profile %s was unsuccessful: %s.", profile.name, err.message),
    });
    task.endTask("error", err);
    throw err;
  };

  const sourceFiles = files.map((file) => {
    return { path: file, name: path.basename(file), ext: path.extname(file) };
  });

  const opt: ExporterOptions = {
    profile,
    sourceFiles,
    targetDirectory: dir.path,
    cwd: dir.path,
    defaultsOverride: {
      title: config.title,
      csl:
        typeof config.cslStyle === "string" && config.cslStyle.length > 0
          ? config.cslStyle
          : undefined,
      template: templateOf(config, profile),
    },
  };

  app.log.info(`[Project] Exporting ${config.title} using profile ${profile.name}.`);
  const result = await makeExport(opt, app.log, app.config, app.assets, app.links.index).catch(
    stop,
  );
  if (result.code !== 0) {
    stop(
      new Error(
        `${trans("The export ended with the exit code %s.", result.code)}\n${result.stderr.join("\n").trim()}`,
      ),
    );
  }

  const readableFormat =
    profile.writer in PANDOC_WRITERS ? PANDOC_WRITERS[profile.writer] : profile.writer;
  task.update({
    title: trans('Project "%s" has been exported.', config.title),
    info: trans("Project has been exported to %s.", readableFormat),
    successInteraction: () => {
      shell.openPath(result.targetFile).catch((err) => {
        app.log.error(`[Project] Could not open file '${result.targetFile}'`, err);
      });
    },
  });
  task.endTask("success");
}

/**
 * The template of a Project for an export with a profile. The LaTeX template
 * is for each export that goes through TeX: the writers of `isTexWriter` and
 * the PDF recipe. The HTML template is for the writers of `isHtmlWriter`.
 * These are the families of the settings `export.latexTemplate` and
 * `export.htmlTemplate`.
 *
 * @param   {ProjectSettings}     config   The Project settings
 * @param   {ValidPandocProfile}  profile  The profile
 *
 * @return  {string|undefined}             The template, or undefined when the
 *                                         Project sets none for the profile
 */
function templateOf(config: ProjectSettings, profile: ValidPandocProfile): string | undefined {
  const goesThroughTex =
    profile.writer === "compile-pandoc" || isTexWriter(parseReaderWriter(profile.writer).name);
  if (goesThroughTex && config.templates.tex !== "") {
    return config.templates.tex;
  }
  if (isHtmlWriter(parseReaderWriter(profile.writer).name) && config.templates.html !== "") {
    return config.templates.html;
  }
  return undefined;
}

function openDirectory(logger: LogProvider, dirPath: string): void {
  // Whoever thought it would be great to have an async function RESOLVE
  // with the error instead of rejecting was definitely a f***ing genius.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  shell.openPath(dirPath).then((error) => {
    if (error !== "") {
      logger.error(`[Project Export] Error opening the directory: ${error}`, error);
    }
  });
}

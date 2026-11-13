/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL directory functions
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains utility functions for dealing with directories.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { hasErrnoCode } from "@common/util/is-errno-exception";
import isFile from "@common/util/is-file";
import safeAssign from "@common/util/safe-assign";
import type {
  DirDescriptor,
  DirectoryMetadataProblem,
  DirectorySettings,
  ProjectNavigationItem,
  ProjectSettings,
  SortMethod,
} from "@dts/common/fsal";
import { promises as fs } from "fs";
import path from "path";
import { readQuartoManifest } from "source/app/util/quarto-project";
import { resolveRealPath } from "source/app/util/real-path";
import { schemaIssueSentence } from "source/app/util/schema-issues";
import { z } from "zod";
import { getFilesystemMetadata } from "./util/get-fs-metadata";
import { writeTextFile } from "./util/write-text-file";

/** The file of a directory that holds the settings of the author. */
const SETTINGS_FILE = ".ztr-directory";

/** The manifest of a Quarto project that sits in the directory it describes. */
export const QUARTO_MANIFEST_NAME = "_quarto.yml";

/**
 * The shape of a settings file: an object, whose nested settings are objects.
 * The values themselves are taken as they are.
 */
const settingsFileSchema = z.looseObject({
  explorer: z.looseObject({}).optional(),
  project: z
    .looseObject({
      manifest: z.looseObject({}).optional(),
      templates: z.looseObject({}).optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Determines what will be written to file (.ztr-directory)
 */
const SETTINGS_TEMPLATE: DirectorySettings = {
  sorting: "name-up",
  explorer: {
    displayName: "inherit",
    sortMetadataKey: "zettlr-order_",
    foldersFirst: null,
    projectFilter: "all",
  },
  project: null, // Default: no project
  icon: null, // Default: no icon
  color: null, // Default: no color
  quartoManifest: null, // Default: a manifest, if any, sits in the directory
};

/**
 * Used to insert a default project
 */
const PROJECT_TEMPLATE: ProjectSettings = {
  manifest: { kind: "zettlr" },
  // General values that not only pertain to the PDF generation
  title: "Untitled", // Default project title is the directory's name
  profiles: [], // NOTE: Must correspond to the defaults in ProjectProperties.vue
  files: [], // A list of absolute paths to the files to be included, sorted (!)
  cslStyle: "", // A path to an optional CSL style file.
  templates: {
    tex: "", // An optional tex template
    html: "", // An optional HTML template
  },
};

/**
 * A change of the settings of a directory whose settings file could not be
 * read. The file holds what the author set, so no write replaces it.
 */
export class DirectorySettingsUnreadableError extends Error {
  constructor(directory: DirDescriptor, problem: DirectoryMetadataProblem) {
    super(
      trans(
        "The settings of %s were not changed: the settings file %s could not be read (%s).",
        directory.path,
        problem.path,
        problem.message,
      ),
    );
    this.name = "DirectorySettingsUnreadableError";
  }
}

/**
 * Where the manifest of this directory is: the path it is bound to, or the
 * manifest in the directory itself. This is the path as the author and the
 * watcher name it; the manifest is read through its real path.
 *
 * @param   {DirDescriptor}  dir  The directory
 *
 * @return  {string}              The path of the manifest
 */
export function quartoManifestLocation(dir: DirDescriptor): string {
  const manifest = dir.settings.quartoManifest;
  return manifest === null
    ? path.join(dir.path, QUARTO_MANIFEST_NAME)
    : path.resolve(dir.path, manifest);
}

/**
 * A file as this directory's project names it: relative to the directory, with
 * Unix separators, which is what every reader of ProjectSettings.files and of
 * a navigation item resolves against the directory.
 *
 * @param   {string}  dirPath   The directory the project belongs to
 * @param   {string}  filePath  The file's real path
 *
 * @return  {string}            The project-relative path
 */
function projectRelative(dirPath: string, filePath: string): string {
  return path.relative(dirPath, filePath).split(path.sep).join("/");
}

/**
 * Derives this directory's Quarto project from its manifest. The manifest is
 * the only place a book's chapter order and bibliographies are written down,
 * so the project is rebuilt from it on every load: a project stored in
 * .ztr-directory never stands in for the manifest it came from.
 *
 * A project the user wrote themselves is not derived from anything, and is
 * left alone.
 *
 * A manifest that gives no book leaves the directory without a Project. The
 * directory names the manifest and the cause when the manifest cannot be
 * read, is not YAML, or is the manifest of a book without the fields of a
 * book. A manifest of another kind of Quarto project is a problem only for a
 * binding: the author said that the bound file describes this directory.
 *
 * @param   {DirDescriptor}  dir  The directory
 */
async function parseQuartoManifest(dir: DirDescriptor): Promise<void> {
  dir.metadataProblems = dir.metadataProblems.filter((problem) => problem.source !== "manifest");
  if (dir.settings.project !== null && dir.settings.project.manifest.kind !== "quarto") {
    return;
  }

  dir.settings.project = null;
  const location = quartoManifestLocation(dir);
  const isBound = dir.settings.quartoManifest !== null;
  const unusable = (message: string): void => {
    dir.metadataProblems.push({ source: "manifest", path: location, message });
  };

  const manifestPath = resolveRealPath(location);
  const read = await fs.readFile(manifestPath, "utf8").then(
    (source) => ({ source }),
    (cause: NodeJS.ErrnoException) => ({ cause }),
  );
  if ("cause" in read) {
    // A directory without a manifest is a plain directory.
    const isAbsent = hasErrnoCode(read.cause, "ENOENT", "ENOTDIR", "EISDIR");
    if (isBound || !isAbsent) {
      unusable(read.cause.message);
    }
    return;
  }

  const reading = readQuartoManifest(path.dirname(manifestPath), read.source);
  if (reading.kind === "unusable") {
    unusable(reading.message);
    return;
  }
  if (reading.kind === "not-a-book") {
    if (isBound) {
      unusable(trans("The file is not the manifest of a Quarto book."));
    }
    return;
  }
  const quarto = reading.project;
  // The manifest resolves its chapters to real files, which may lie anywhere
  // under this directory. The project names each one the way every reader
  // expects: relative to the directory it belongs to.
  const root = resolveRealPath(dir.path);
  const chapter = (filePath: string): string => projectRelative(root, filePath);
  dir.settings.project = {
    ...PROJECT_TEMPLATE,
    title: quarto.title,
    files: quarto.files.map(chapter),
    manifest: {
      kind: "quarto",
      path: manifestPath,
      bibliographies: quarto.bibliographies,
      navigation: quarto.navigation.map((item): ProjectNavigationItem => {
        if (item.kind === "chapter") {
          return { kind: "chapter", path: chapter(item.path) };
        }
        const chapters = item.chapters.map(chapter);
        return item.kind === "part"
          ? { kind: "part", title: item.title, chapters }
          : { kind: "part-file", path: chapter(item.path), chapters };
      }),
    },
  };
}

/** Re-derives a Quarto Project after its authoritative manifest changed. */
export async function refreshQuartoProject(dir: DirDescriptor): Promise<void> {
  if (dir.settings.project?.manifest.kind !== "quarto" && dir.settings.quartoManifest === null) {
    throw new Error(
      `[FSAL Dir] Cannot refresh Quarto project for ${dir.path}: no Quarto project is bound`,
    );
  }
  // A derived Quarto project is explicitly disposable; clear it so the parser
  // cannot mistake it for a user-authored Zettlr project.
  if (dir.settings.project?.manifest.kind === "quarto") {
    dir.settings.project = null;
  }
  await parseQuartoManifest(dir);
}

/**
 * The settings the user gave this directory. A Quarto project is derived from
 * its manifest rather than authored here, and the binding that names the
 * manifest is what the user actually said, so only the binding is the
 * directory's own.
 *
 * @param   {DirDescriptor}      dir  The directory
 *
 * @return  {DirectorySettings}       The settings to compare and to write
 */
function authoredSettings(dir: DirDescriptor): DirectorySettings {
  return dir.settings.project?.manifest.kind === "quarto"
    ? { ...dir.settings, project: null }
    : dir.settings;
}

/**
 * This function checks if a directory has the default settings. This can be
 * useful to determine, if, e.g., the corresponding dotfile will be removed
 * after removing its project settings.
 *
 * @param   {DirDescriptor}  dir  The directory to check
 *
 * @return  {boolean}             Returns true if the settings are the same as default.
 */
export function hasDefaultSettings(dir: DirDescriptor): boolean {
  return JSON.stringify(authoredSettings(dir)) === JSON.stringify(SETTINGS_TEMPLATE);
}

/**
 * Persists the settings of a directory to disk.
 *
 * @param   {DirDescriptor}  dir  The directory descriptor
 */
async function persistSettings(dir: DirDescriptor): Promise<void> {
  const unread = dir.metadataProblems.find((problem) => problem.source === "settings");
  if (unread !== undefined) {
    throw new DirectorySettingsUnreadableError(dir, unread);
  }
  const settingsFile = path.join(dir.path, SETTINGS_FILE);
  if (hasDefaultSettings(dir)) {
    // Only persist the settings if they are not default. If they are default,
    // remove a possible .ztr-directory-file
    if (isFile(settingsFile)) {
      try {
        await fs.unlink(settingsFile);
      } catch (err) {
        if (err instanceof Error) {
          err.message = `Error removing default .ztr-directory: ${err.message}`;
        }
        throw err;
      }
    }
    return;
  }
  await writeTextFile(settingsFile, JSON.stringify(authoredSettings(dir)));
}

/**
 * Reads the settings file of a directory. A file that cannot be read, is not
 * JSON or does not hold settings stays on disk as it is: the directory gets
 * the default settings and names the file and the cause. A load changes
 * nothing on disk.
 *
 * @param   {DirDescriptor}  dir  The directory descriptor.
 */
async function parseSettings(dir: DirDescriptor): Promise<void> {
  const settingsFile = path.join(dir.path, SETTINGS_FILE);
  const unusable = (message: string): void => {
    dir.metadataProblems.push({ source: "settings", path: settingsFile, message });
  };

  const read = await fs
    .readFile(settingsFile, "utf8")
    .then((text) => settingsFileSchema.safeParse(JSON.parse(text)))
    .then(
      (parsed) => ({ parsed }),
      (cause: Error) => ({ cause }),
    );
  if ("cause" in read) {
    // A directory without a settings file has the default settings.
    if (!hasErrnoCode(read.cause, "ENOENT")) {
      unusable(read.cause.message);
    }
    return;
  }
  if (!read.parsed.success) {
    unusable(schemaIssueSentence(read.parsed.error));
    return;
  }

  dir.settings = safeAssign(read.parsed.data as Partial<DirectorySettings>, SETTINGS_TEMPLATE);
  if (dir.settings.project !== null) {
    // We have a project, so we need to sanitize the values (in case
    // that there have been changes to the config). We'll just use
    // the code from the config provider.
    dir.settings.project = safeAssign(dir.settings.project, PROJECT_TEMPLATE);
  }
}

/**
 * Reads in a directory, returning a corresponding descriptor object. Does NOT
 * read in the entire sub-tree of the filesystem.
 *
 * A directory that refuses its content (no read or no search permission) has
 * a descriptor that names the cause; its settings and its manifest are not
 * read.
 *
 * @param   {string}              currentPath  The directory's path
 *
 * @return  {Promise<DirDescriptor>}           Resolves with the descriptor
 */
export async function parse(currentPath: string): Promise<DirDescriptor> {
  // Prepopulate
  const dir: DirDescriptor = {
    path: currentPath,
    name: path.basename(currentPath),
    dir: path.dirname(currentPath),
    size: 0,
    type: "directory",
    isGitRepository: false,
    metadataProblems: [],
    modtime: 0, // You know when something has gone wrong: 01.01.1970
    creationtime: 0,
    settings: JSON.parse(JSON.stringify(SETTINGS_TEMPLATE)),
  };

  const metadata = await getFilesystemMetadata(dir.path);
  dir.modtime = metadata.modtime;
  dir.creationtime = metadata.birthtime;

  const refusal = await fs.access(dir.path, fs.constants.R_OK | fs.constants.X_OK).then(
    () => undefined,
    (cause: NodeJS.ErrnoException) => cause,
  );
  if (refusal !== undefined) {
    if (!hasErrnoCode(refusal, "EACCES", "EPERM")) {
      throw refusal;
    }
    dir.metadataProblems.push({ source: "directory", path: dir.path, message: refusal.message });
    return dir;
  }

  dir.isGitRepository = await fs.lstat(path.join(dir.path, ".git")).then(
    (stats) => stats.isDirectory(),
    (cause: NodeJS.ErrnoException) => {
      // A directory without a .git entry is not a repository.
      if (hasErrnoCode(cause, "ENOENT", "ENOTDIR")) {
        return false;
      }
      throw cause;
    },
  );

  await parseSettings(dir);
  await parseQuartoManifest(dir);
  return dir;
}

/**
 * Returns a dummy descriptor that only contains aminimal amount of information
 * along with setting the dirNotFoundFlag to true.
 *
 * @param   {string}         dirPath  The (not found) directory's path
 *
 * @return  {DirDescriptor}           The resulting descriptor
 */
export function getDirNotFoundDescriptor(dirPath: string): DirDescriptor {
  return {
    path: dirPath,
    name: path.basename(dirPath),
    dir: path.dirname(dirPath),
    size: 0,
    type: "directory",
    isGitRepository: false,
    metadataProblems: [],
    modtime: 0, // ¯\_(ツ)_/¯
    creationtime: 0,
    // Settings are expected by some functions
    settings: JSON.parse(JSON.stringify(SETTINGS_TEMPLATE)),
    dirNotFoundFlag: true,
  };
}

/**
 * Safely assigns an arbitrary settings object to dirObject's settings.
 *
 * @param   {DirDescriptor}  dirObject  The directory descriptor in question.
 * @param   {any}            settings   A settings object to be assigned
 */
export async function setSetting(
  dirObject: DirDescriptor,
  settings: Partial<DirDescriptor["settings"]>,
): Promise<void> {
  dirObject.settings = safeAssign(settings, dirObject.settings);
  await persistSettings(dirObject);
}

/**
 * Sorts the given dirObject according to the sorting method
 *
 * @param   {DirDescriptor}  dirObject  The directory object
 * @param   {string}         method     The sorting method
 */
export async function changeSorting(dirObject: DirDescriptor, method?: SortMethod): Promise<void> {
  // If the caller omits the method, it should remain unchanged
  if (method === undefined) {
    method = dirObject.settings.sorting;
  }

  dirObject.settings.sorting = method;
  // Persist the settings to disk
  await persistSettings(dirObject);
}

/**
 * Creates a project from the given dirObject.
 *
 * @param   {DirDescriptor}  dirObject   The directory descriptor
 * @param   {any}            properties  Initial properties to set
 */
export async function makeProject(
  dirObject: DirDescriptor,
  properties: Partial<ProjectSettings>,
): Promise<void> {
  dirObject.settings.project = safeAssign(properties, PROJECT_TEMPLATE);
  await persistSettings(dirObject);
}

/**
 * Updates the project properties of the given directory and immediately persists
 * them to disk. The properties are assigned safely.
 *
 * @param   {DirDescriptor}  dirObject   The directory descriptor
 * @param   {any}            properties  The properties to set
 *
 * @return {boolean}                     Returns false if no properties changed
 */
export async function updateProjectProperties(
  dirObject: DirDescriptor,
  properties: ProjectSettings,
): Promise<void> {
  if (dirObject.settings.project === null) {
    throw new Error(
      `[FSAL Dir] Attempted to update project settings on dir ${dirObject.path}, but it is not a project!`,
    );
  }

  dirObject.settings.project = safeAssign(properties, dirObject.settings.project);
  // Immediately reflect on disk
  await persistSettings(dirObject);
}

// Removes a project
/**
 * Removes an existing project from the dirObject.
 *
 * @param   {DirDescriptor}  dirObject  The directory descriptor
 */
export async function removeProject(dirObject: DirDescriptor): Promise<void> {
  dirObject.settings.project = null;
  await persistSettings(dirObject);
}

/**
 * What became of a binding the user asked for.
 */
export type QuartoManifestBinding =
  | { kind: "bound"; manifest: string }
  | { kind: "rejected"; reason: "not-a-file" | "outside-directory" };

/**
 * Binds a directory to the Quarto manifest that describes it, and derives the
 * project from it. The manifest must be a file inside the directory: its
 * chapters are resolved from where it sits, so a manifest outside the
 * directory would describe a book whose chapters are outside the workspace.
 *
 * @param   {DirDescriptor}  dirObject     The directory descriptor
 * @param   {string}         manifestPath  The manifest the user chose
 *
 * @return  {Promise<QuartoManifestBinding>}  The binding, or why there is none
 */
export async function bindQuartoManifest(
  dirObject: DirDescriptor,
  manifestPath: string,
): Promise<QuartoManifestBinding> {
  const manifest = resolveRealPath(path.resolve(dirObject.path, manifestPath));

  if (!isFile(manifest)) {
    return { kind: "rejected", reason: "not-a-file" };
  }

  const relative = path.relative(resolveRealPath(dirObject.path), manifest);
  if (relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) {
    return { kind: "rejected", reason: "outside-directory" };
  }

  dirObject.settings.quartoManifest = relative;
  await persistSettings(dirObject);
  await parseQuartoManifest(dirObject);
  return { kind: "bound", manifest: relative };
}

/**
 * Removes the binding, and with it the project that was derived from the
 * manifest it named.
 *
 * @param   {DirDescriptor}  dirObject  The directory descriptor
 */
export async function unbindQuartoManifest(dirObject: DirDescriptor): Promise<void> {
  dirObject.settings.quartoManifest = null;
  await persistSettings(dirObject);
  await parseQuartoManifest(dirObject);
}

// FSAL types available in both main process and renderer process

import type { DocumentReferenceSnapshot } from "./references";

/**
 * One item of a book's chapter list. A part has a title, or it names a file
 * that holds its title and its introduction (`part-file`); that file is a
 * document of the book, before the chapters of the part.
 */
export type ProjectNavigationItem =
  | { kind: "chapter"; path: string }
  | { kind: "part"; title: string; chapters: string[] }
  | { kind: "part-file"; path: string; chapters: string[] };

export type ProjectManifest =
  | { kind: "zettlr" }
  | {
      kind: "quarto";
      path: string;
      bibliographies: string[];
      navigation: ProjectNavigationItem[];
    };

export interface ProjectSettings {
  /** The file that owns this project definition. */
  manifest: ProjectManifest;
  /**
   * The title of the project, will be used, e.g., as title and filename for
   * projects.
   */
  title: string;
  /**
   * A list of project filenames (found in the defaults folder in the app data)
   * to use for export.
   */
  profiles: string[];
  /**
   * A sorted (!) list of project-relative paths to the files that should be
   * included in the export of this project, including the ordering in which
   * they should be included. A project derived from a Quarto manifest names
   * each chapter this way too, whatever route the manifest reached it by.
   */
  files: string[];
  /**
   * An optional, deviating CSL Style to use for citations within this project.
   */
  cslStyle: string;
  /**
   * Template files for various export profiles that override any templates
   * provided by the templates themselves.
   */
  templates: {
    tex: string;
    html: string;
  };
}

/**
 * An interface containing meta information all
 * descriptors should provide.
 */
export interface FSMetaInfo {
  path: string; // absolutePath
  dir: string; // path.dirname(absolutePath)
  name: string; // path.basename(absolutePath)
  type: "file" | "directory" | "code" | "other";
  size: number;
  modtime: number;
  creationtime: number;
}

/** How Markdown documents are labelled in Explorer surfaces. */
export type FileNameDisplay = "filename" | "title" | "heading" | "title+heading";

/**
 * A directory's persisted Explorer ordering. `name-*` and `time-*` are the
 * legacy methods: they continue to mean "the configured display name" and
 * "the configured fileMetaTime" respectively. The explicit methods decouple
 * the visible label from the ordering relation.
 */
export type SortMethod =
  | "name-up"
  | "name-down"
  | "time-up"
  | "time-down"
  | "filename-up"
  | "filename-down"
  | "title-up"
  | "title-down"
  | "heading-up"
  | "heading-down"
  | "modtime-up"
  | "modtime-down"
  | "creationtime-up"
  | "creationtime-down"
  | "frontmatter-up"
  | "frontmatter-down"
  | "book-up"
  | "book-down";

export type ProjectFileFilter = "all" | "included" | "omitted";

/** Directory-local Explorer controls that do not belong to the project model. */
export interface DirectoryExplorerSettings {
  /** `inherit` means the global fileNameDisplay preference. */
  displayName: "inherit" | FileNameDisplay;
  /** Metadata key used by frontmatter-* sorting. */
  sortMetadataKey: string;
  /** `null` means the global sortFoldersFirst preference. */
  foldersFirst: boolean | null;
  /** Optional project-membership view over files in this directory. */
  projectFilter: ProjectFileFilter;
}

export interface DirectorySettings {
  /**
   * Describes the sorting that should be applied to the directory
   */
  sorting: SortMethod;
  /** Authoring/browser presentation local to this directory. */
  explorer: DirectoryExplorerSettings;
  /**
   * Can hold an optional custom icon for the directory
   */
  icon: string | null;
  /**
   * Holds the project settings if it's a project.
   */
  project: ProjectSettings | null;
  /**
   * Holds an optional color for the directory.
   */
  color: string | null;
  /**
   * Names the Quarto manifest that describes this directory when the manifest
   * does not sit in the directory itself, relative to the directory. The
   * binding is an input: the project it describes is derived from the manifest
   * on every load, and never written back here.
   */
  quartoManifest: string | null;
}

/**
 * A part of the metadata of a directory that the application could not use.
 * The directory is listed without that part: with the default settings for
 * `settings`, without a Project for `manifest`, without children for
 * `directory`. A workspace whose rules file cannot be read (`rules`) is
 * listed as missing, without children.
 */
export interface DirectoryMetadataProblem {
  /**
   * What could not be used: the settings file `.ztr-directory`, the Quarto
   * manifest, the content of the directory itself, or the rules file
   * `.zettlrignore` of a workspace.
   */
  source: "settings" | "manifest" | "directory" | "rules";
  /** The file or the directory that the problem is in. */
  path: string;
  /** The cause. */
  message: string;
}

/**
 * The FSAL directory descriptor
 */
export interface DirDescriptor extends FSMetaInfo {
  // Settings are properties that must be persisted separately in a
  // .ztr-directory file, since they are not bound to the directory.
  settings: DirectorySettings;
  type: "directory";
  isGitRepository: boolean;
  /** Each part of the metadata that the last load could not use. */
  metadataProblems: DirectoryMetadataProblem[];
  dirNotFoundFlag?: boolean; // If the flag is set & true this directory has not been found
}

/** A directory that is a Project. */
export interface ProjectDirDescriptor extends DirDescriptor {
  settings: DirectorySettings & { project: ProjectSettings };
}

/**
 * A value of the YAML core schema, which `yaml.parse` produces: a scalar, a
 * sequence or a mapping (https://yaml.org/spec/1.2.2/#103-core-schema).
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping;

/** A YAML mapping with string keys, such as a parsed frontmatter block. */
export interface YamlMapping {
  [key: string]: YamlValue;
}

/**
 * Why the last read of the text of a file failed: the code and the message of
 * the filesystem error.
 */
export interface FileReadError {
  code: string;
  message: string;
}

/**
 * The FSAL Markdown file descriptor
 */
export interface MDFileDescriptor extends FSMetaInfo {
  ext: string;
  id: string;
  type: "file";
  tags: string[];
  links: string[]; // Any outlinks declared in the file
  /** The URL, as written, of each Markdown link and image that can name a file. */
  fileLinks: string[];
  citekeys: string[]; // Any citation keys declared in the file
  bom: string; // An optional BOM
  wordCount: number;
  charCount: number;
  /** First authored Markdown heading, regardless of heading depth. */
  firstHeading: string | null;
  /** First prose sentence, used only when no authored heading exists. */
  firstSentence: string | null;
  /**
   * The identity of the parser that produced this descriptor: its version and
   * the settings it read. A cached descriptor of another parser is parsed again.
   */
  parsedWith?: string;
  yamlTitle: string | undefined;
  /** The YAML `aliases`: further names a wikilink may use for this document. */
  aliases: string[];
  frontmatter: YamlMapping | null;
  linefeed: string;
  /**
   * The document's saved reference surface (pandoc-crossref and theorem-div
   * definitions and occurrences), extracted in the same markdownToAST pass
   * that produces tags, links, and citekeys (issue #1).
   */
  references: DocumentReferenceSnapshot;
  /**
   * Present when the file is there and its text could not be read. The other
   * fields then describe a file without text.
   */
  readError?: FileReadError;
}

/**
 * The FSAL code file descriptor (.tex, .yml)
 */
export interface CodeFileDescriptor extends FSMetaInfo {
  ext: string;
  type: "code";
  bom: string; // An optional BOM
  linefeed: string;
  /** Present when the file is there and its text could not be read. */
  readError?: FileReadError;
}

/**
 * The FSAL other (non-MD and non-Tex) file descriptor
 */
export interface OtherFileDescriptor extends FSMetaInfo {
  type: "other";
  ext: string;
}

export type AnyDescriptor =
  | DirDescriptor
  | MDFileDescriptor
  | CodeFileDescriptor
  | OtherFileDescriptor;
export type MaybeRootDescriptor = DirDescriptor | MDFileDescriptor | CodeFileDescriptor;

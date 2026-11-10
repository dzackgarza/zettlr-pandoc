/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ignore rules
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The rules that say which files and folders of a workspace
 *                  the app lists: the gitignore rules and the file type
 *                  settings. A rule is one gitignore line; the `ignore`
 *                  package is the matcher. The main process filters with this
 *                  module, and the windows use it to mark what a rule matches,
 *                  so it imports nothing that only one of them has. Paths use
 *                  `/` as the separator.
 *
 * END HEADER
 */

import ignore, { type Ignore } from "ignore";
import {
  hasDataExt,
  hasExt,
  hasImageExt,
  hasMdOrCodeExt,
  hasMSOfficeExt,
  hasOpenOfficeExt,
  hasPDFExt,
} from "./file-extention-checks";
import { innermostRoot, isInsideRoot } from "./renderer-path-polyfill";

/** The rules file at a workspace root. Its rules add to the global ones. */
export const WORKSPACE_RULES_FILE = ".zettlrignore";

/**
 * The file types the app lists. A path of a type that these settings leave
 * out is hidden like a path that a rule matches.
 */
export type FileTypeVisibility = {
  /** `fileManager.filters.include`: only files with these extensions; empty lists every type. */
  include: readonly string[];
  /** `files.<type>.showInFilemanager` of each type group. */
  images: boolean;
  pdf: boolean;
  msoffice: boolean;
  openOffice: boolean;
  dataFiles: boolean;
  dotFiles: boolean;
  /** `attachmentExtensions`: other extensions to list. */
  attachmentExtensions: readonly string[];
};

/**
 * Every type group listed and no Include list. A file of no known type still
 * needs its extension in `attachmentExtensions`.
 */
export const EVERY_FILE_TYPE: FileTypeVisibility = {
  include: [],
  images: true,
  pdf: true,
  msoffice: true,
  openOffice: true,
  dataFiles: true,
  dotFiles: true,
  attachmentExtensions: [],
};

/** The rule sources. One value is immutable; a change makes a new one. */
export type IgnoreRuleSources = {
  /** The configuration value `fileManager.ignoreRules`, one gitignore line each. */
  globalRules: readonly string[];
  /** Each open workspace root and the text of its rules file ('' when it has none). */
  workspaceRules: ReadonlyMap<string, string>;
  /**
   * The configuration value `fileManager.showIgnored`. While it is true no rule
   * hides a path from any consumer; the file manager only marks the matches.
   */
  showIgnored: boolean;
  /** The file types the app lists. */
  fileTypes: FileTypeVisibility;
};

/** What the rules say about one path. */
export interface IgnoreFilter {
  /**
   * True when a rule matches the path or its file type is left out, whatever
   * the reveal toggle says.
   */
  matches: (absPath: string, isDirectory: boolean) => boolean;
  /** True when a gitignore rule matches the path. The file types play no part. */
  ruleMatches: (absPath: string, isDirectory: boolean) => boolean;
  /** True when the app must not list the path: it matches and the reveal toggle is off. */
  hides: (absPath: string, isDirectory: boolean) => boolean;
}

/**
 * The rules file text of one workspace root. The map holds every open root,
 * with '' for a root without a rules file, so a missing root is a defect.
 */
export function rulesTextOf(texts: ReadonlyMap<string, string>, root: string): string {
  const text = texts.get(root);
  if (text === undefined) {
    throw new Error(`No ignore rules are known for ${root}: Not an open workspace`);
  }
  return text;
}

function hasExtension(filePath: string, extension: string): boolean {
  const trimmed = extension.trim().toLowerCase();
  const normalized = trimmed === "" || trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  return normalized !== "" && filePath.toLowerCase().endsWith(normalized);
}

/**
 * Whether the file type settings leave a path out. A path below a dot folder
 * is a dot path, and a folder is left out only as a dot path. A file must have an included extension; then the setting
 * of its type group decides. Markdown and code files are always listed, and
 * any other file only with an extension in `attachmentExtensions`.
 */
function typeLeavesOut(
  types: FileTypeVisibility,
  absPath: string,
  relative: string,
  isDirectory: boolean,
): boolean {
  const isDot = relative.split("/").some((segment) => segment.startsWith("."));
  if (isDirectory) {
    return isDot && !types.dotFiles;
  }
  if (types.include.length > 0 && !types.include.some((ext) => hasExtension(absPath, ext))) {
    return true;
  }
  if (isDot) {
    return !types.dotFiles;
  }
  if (hasImageExt(absPath)) {
    return !types.images;
  }
  if (hasPDFExt(absPath)) {
    return !types.pdf;
  }
  if (hasMSOfficeExt(absPath)) {
    return !types.msoffice;
  }
  if (hasOpenOfficeExt(absPath)) {
    return !types.openOffice;
  }
  if (hasDataExt(absPath)) {
    return !types.dataFiles;
  }
  if (hasMdOrCodeExt(absPath)) {
    return false;
  }
  return !hasExt(absPath, [...types.attachmentExtensions]);
}

/**
 * Makes the filter of one set of rule sources. A path is judged by the global
 * rules and then the rules file of its judging root, and by the file type
 * settings. No rule hides a root in its own tree, and a path outside every
 * root is never matched.
 */
export function createIgnoreFilter(sources: IgnoreRuleSources): IgnoreFilter {
  const roots = [...sources.workspaceRules.keys()];
  const matchers = new Map<string, Ignore>();

  const matcherOf = (root: string): Ignore => {
    let matcher = matchers.get(root);
    if (matcher === undefined) {
      matcher = ignore({ ignorecase: false })
        .add(sources.globalRules)
        .add(rulesTextOf(sources.workspaceRules, root));
      matchers.set(root, matcher);
    }
    return matcher;
  };

  const judge = (absPath: string, isDirectory: boolean, withTypes: boolean): boolean => {
    const root = innermostRoot(absPath, roots);
    if (root === undefined) {
      return false;
    }
    const relative = absPath.slice(root.length + 1);
    return (
      (withTypes && typeLeavesOut(sources.fileTypes, absPath, relative, isDirectory)) ||
      matcherOf(root).ignores(isDirectory ? `${relative}/` : relative)
    );
  };

  const matches = (absPath: string, isDirectory: boolean): boolean =>
    judge(absPath, isDirectory, true);

  return {
    matches,
    ruleMatches: (absPath, isDirectory) => judge(absPath, isDirectory, false),
    hides: (absPath, isDirectory) => !sources.showIgnored && matches(absPath, isDirectory),
  };
}

/**
 * Writes a file or folder name as a pattern that matches that name only.
 * gitignore(5): a backslash quotes `\`, `*`, `?`, `[` and `]`, a `#` or `!`
 * at the start of a line, and a trailing space.
 */
function escapeLiteral(text: string): string {
  return text
    .replace(/[\\*?[\]]/g, "\\$&")
    .replace(/^[#!]/, "\\$&")
    .replace(/ $/, "\\ ");
}

/** The path below `root`, written as the literal start of an anchored rule. */
function anchoredLiteral(root: string, absPath: string): string {
  if (!isInsideRoot(absPath, root)) {
    throw new Error(`Cannot write a rule for ${absPath}: it is not inside ${root}`);
  }
  return (
    "/" +
    absPath
      .slice(root.length + 1)
      .split("/")
      .map(escapeLiteral)
      .join("/")
  );
}

/** The rule that matches every file, or every folder, with this name. */
export function ruleForName(name: string, isDirectory: boolean): string {
  return escapeLiteral(name) + (isDirectory ? "/" : "");
}

/** The rule that matches this one path of the workspace `root`. */
export function ruleForPath(root: string, absPath: string, isDirectory: boolean): string {
  return anchoredLiteral(root, absPath) + (isDirectory ? "/" : "");
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function textOf(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/**
 * Returns the rules file text of `root` after one path is hidden or shown
 * again. Hide removes a negation of the path, then adds the rule of the path
 * when the path is still listed. Unhide removes the rule of the path, then
 * adds a negation when a pattern still matches it. Every other line stays.
 *
 * @throws when the path stays hidden because a folder above it is hidden;
 *         gitignore cannot list a path again below a hidden folder.
 */
export function setPathIgnored(
  text: string,
  globalRules: readonly string[],
  root: string,
  absPath: string,
  isDirectory: boolean,
  ignored: boolean,
): string {
  const rule = ruleForPath(root, absPath, isDirectory);
  const negation = `!${rule}`;
  const isIgnored = (lines: string[]): boolean => {
    const workspaceRules = new Map([[root, textOf(lines)]]);
    return createIgnoreFilter({
      globalRules,
      workspaceRules,
      showIgnored: false,
      fileTypes: EVERY_FILE_TYPE,
    }).ruleMatches(absPath, isDirectory);
  };

  const lines = linesOf(text).filter((line) => line !== (ignored ? negation : rule));
  if (isIgnored(lines) !== ignored) {
    lines.push(ignored ? rule : negation);
  }
  if (isIgnored(lines) !== ignored) {
    throw new Error(`Cannot show ${absPath}: a folder above it is hidden`);
  }
  return textOf(lines);
}

/**
 * A rule of a rules file that names a path at or below a given path.
 * `rest` is what follows that path in the rule: '' or '/' for the path itself,
 * '/sub/…' for a path below it.
 */
interface PathRule {
  negated: boolean;
  rest: string;
}

/**
 * Splits the lines of a rules file into the rules that name `absPath` or a
 * path below it and the lines that stay. `replace` gives the line that takes
 * the place of such a rule, or undefined to take the rule out.
 */
function mapPathRules(
  text: string,
  root: string,
  absPath: string,
  replace: (rule: PathRule) => string | undefined,
): string {
  const literal = anchoredLiteral(root, absPath);
  const lines: string[] = [];
  for (const line of linesOf(text)) {
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    const rest = body.slice(literal.length);
    if (!body.startsWith(literal) || (rest !== "" && !rest.startsWith("/"))) {
      lines.push(line);
      continue;
    }
    const replacement = replace({ negated, rest });
    if (replacement !== undefined) {
      lines.push(replacement);
    }
  }
  return textOf(lines);
}

function pathRuleLine(root: string, absPath: string, rule: PathRule): string {
  return (rule.negated ? "!" : "") + anchoredLiteral(root, absPath) + rule.rest;
}

/** The rules files whose text differs from the one in `texts`. */
function changedTexts(
  texts: ReadonlyMap<string, string>,
  next: Map<string, string>,
): Map<string, string> {
  return new Map([...next].filter(([root, text]) => text !== texts.get(root)));
}

/**
 * Keeps the rules that name a path in step with a rename or a move of it.
 * `texts` holds the rules file of each workspace root. A rule that names
 * `oldPath`, or a path below it, names the same path under `newPath`
 * afterwards. When the path moves to another workspace, its rules move to the
 * rules file of that workspace; when it leaves every workspace, they go.
 *
 * @return  The new text of each rules file that changes
 */
export function movePathRules(
  texts: ReadonlyMap<string, string>,
  oldPath: string,
  newPath: string,
): Map<string, string> {
  const oldRoot = innermostRoot(oldPath, texts.keys());
  const newRoot = innermostRoot(newPath, texts.keys());
  if (oldRoot === undefined) {
    return new Map();
  }

  const moved: string[] = [];
  const next = new Map<string, string>();
  next.set(
    oldRoot,
    mapPathRules(rulesTextOf(texts, oldRoot), oldRoot, oldPath, (rule) => {
      if (newRoot === oldRoot) {
        return pathRuleLine(oldRoot, newPath, rule);
      }
      if (newRoot !== undefined) {
        moved.push(pathRuleLine(newRoot, newPath, rule));
      }
      return undefined;
    }),
  );
  if (newRoot !== undefined && moved.length > 0) {
    next.set(newRoot, textOf([...linesOf(rulesTextOf(texts, newRoot)), ...moved]));
  }
  return changedTexts(texts, next);
}

/**
 * Removes the rules that name a deleted path or a path below it.
 *
 * @return  The new text of each rules file that changes
 */
export function removePathRules(
  texts: ReadonlyMap<string, string>,
  absPath: string,
): Map<string, string> {
  const root = innermostRoot(absPath, texts.keys());
  if (root === undefined) {
    return new Map();
  }
  const text = mapPathRules(rulesTextOf(texts, root), root, absPath, () => undefined);
  return changedTexts(texts, new Map([[root, text]]));
}

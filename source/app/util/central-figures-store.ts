/**
 * Filesystem owner for the centralized authoring figure tree. API clients use
 * relative paths only; containment and symlink checks happen here before any
 * file bytes are read or written.
 */

import { createHash } from "crypto";
import { type Dirent, promises as fs, type Stats } from "fs";
import path from "path";
import { writeTextFile } from "../service-providers/fsal/util/write-text-file";

export type CentralFigureEntryKind = "file" | "directory" | "symlink";

export interface CentralFigureEntry {
  path: string;
  kind: CentralFigureEntryKind;
  size: number;
  modifiedAt: string;
}

export interface CentralFigureReadResult {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  encoding: "utf8" | "base64";
  content: string;
}

export interface CentralFigureSearchHit {
  path: string;
  matchType: "path" | "content";
  line?: number;
  excerpt: string;
}

/** A path of the figures directory that a list or a search could not read. */
export interface CentralFigureNotRead {
  path: string;
  cause: string;
}

export interface CentralFigureListing {
  entries: CentralFigureEntry[];
  /** The folders whose entries, and the entries whose metadata, could not be read. */
  notListed: CentralFigureNotRead[];
}

export interface CentralFigureSearchResult {
  hits: CentralFigureSearchHit[];
  /** The figures that the search could not read, and the folders it could not list. */
  notSearched: CentralFigureNotRead[];
  truncated: boolean;
}

const SEARCH_FILE_LIMIT = 2 * 1024 * 1024;
const SEARCH_HIT_LIMIT = 500;

export class CentralFigureInputError extends Error {}
export class CentralFigureNotFoundError extends Error {}
export class CentralFigureAlreadyExistsError extends Error {}
/** The figures directory of the settings does not exist. */
export class CentralFiguresDirectoryNotFoundError extends Error {}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") {
    return homeDirectory;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

/** One effective figure root shared by live compilation and HTTP access. */
export function resolveCentralFiguresDirectory(
  configuredDirectory: string,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = configuredDirectory.trim();
  if (configured !== "") {
    return path.resolve(expandHome(configured, homeDirectory));
  }
  // The ~/.pandoc TikZ filter resolves its figure tree the same way:
  // FIGURES_SOURCE_DIR when set, otherwise ~/.pandoc/figures.
  const environment = env.FIGURES_SOURCE_DIR;
  if (environment === undefined) {
    return path.join(homeDirectory, ".pandoc", "figures");
  }
  const trimmed = environment.trim();
  if (trimmed === "") {
    throw new Error("FIGURES_SOURCE_DIR is set but empty; unset it or name the figures directory");
  }
  return path.resolve(expandHome(trimmed, homeDirectory));
}

function normalizeRelativePath(value: string): string {
  if (value.includes("\0")) {
    throw new CentralFigureInputError("Figure path contains a NUL byte");
  }
  const unix = value.replaceAll("\\", "/");
  if (unix === "" || unix.startsWith("/") || /^[A-Za-z]:\//u.test(unix)) {
    throw new CentralFigureInputError("Figure path must be a non-empty relative path");
  }
  const segments = unix.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new CentralFigureInputError("Figure path must not contain empty, '.' or '..' components");
  }
  return segments.join("/");
}

/** The real path of the figures directory. A write creates the directory. */
async function rootRealPath(root: string, create: boolean): Promise<string> {
  if (create) {
    await fs.mkdir(root, { recursive: true });
    return await fs.realpath(root);
  }
  try {
    return await fs.realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CentralFiguresDirectoryNotFoundError(
        `The figures directory ${root} does not exist`,
      );
    }
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CentralFigureInputError("Figure path is outside the configured figures directory");
  }
}

async function resolveExistingFile(
  root: string,
  relativePath: string,
): Promise<{ root: string; path: string; relativePath: string }> {
  const normalized = normalizeRelativePath(relativePath);
  const realRoot = await rootRealPath(root, false);
  const candidate = path.join(realRoot, ...normalized.split("/"));
  let stats;
  try {
    stats = await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CentralFigureNotFoundError(`Figure file not found: ${normalized}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new CentralFigureInputError(
      "Figure file is a symbolic link and is not directly accessible",
    );
  }
  if (!stats.isFile()) {
    throw new CentralFigureInputError("Figure path does not name a file");
  }
  const realCandidate = await fs.realpath(candidate);
  assertContained(realRoot, realCandidate);
  return { root: realRoot, path: realCandidate, relativePath: normalized };
}

async function prepareWritableFile(
  root: string,
  relativePath: string,
): Promise<{ path: string; relativePath: string }> {
  const normalized = normalizeRelativePath(relativePath);
  const realRoot = await rootRealPath(root, true);
  // normalizeRelativePath guarantees at least one non-empty segment.
  const segments = normalized.split("/");
  const fileName = segments[segments.length - 1];
  let directory = realRoot;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(directory, segment);
    try {
      const stats = await fs.lstat(next);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new CentralFigureInputError(`Figure folder ${segment} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(next);
    }
    directory = next;
  }
  const target = path.join(directory, fileName);
  assertContained(realRoot, target);
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink() || stats.isDirectory()) {
      throw new CentralFigureInputError("Figure destination is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { path: target, relativePath: normalized };
}

/**
 * The cause of a path that a list or a search could not read: a refusal of
 * the filesystem, or a figure that went away during the search. Any other
 * error goes on.
 */
function causeOf(error: NodeJS.ErrnoException): string {
  if (error instanceof CentralFigureNotFoundError || error.code !== undefined) {
    return error.message;
  }
  throw error;
}

/**
 * Lists the figures directory breadth first. A folder whose entries cannot
 * be read is an entry, and its path is in `notListed`; the root itself must
 * be readable.
 */
export async function listCentralFigures(root: string): Promise<CentralFigureListing> {
  const realRoot = await rootRealPath(root, false);
  const result: CentralFigureEntry[] = [];
  const notListed: CentralFigureNotRead[] = [];
  const queue: Array<{ absolute: string; relative: string }> = [
    { absolute: realRoot, relative: "" },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (current.relative === "") {
        throw error;
      }
      notListed.push({ path: current.relative, cause: causeOf(error as NodeJS.ErrnoException) });
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
      let stats: Stats;
      try {
        stats = await fs.lstat(absolute);
      } catch (error) {
        notListed.push({ path: relative, cause: causeOf(error as NodeJS.ErrnoException) });
        continue;
      }
      const kind: CentralFigureEntryKind = stats.isSymbolicLink()
        ? "symlink"
        : stats.isDirectory()
          ? "directory"
          : "file";
      result.push({
        path: relative,
        kind,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
      if (kind === "directory") {
        queue.push({ absolute, relative });
      }
    }
  }
  return { entries: result, notListed };
}

function decodeUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

export async function readCentralFigure(
  root: string,
  relativePath: string,
): Promise<CentralFigureReadResult> {
  const resolved = await resolveExistingFile(root, relativePath);
  const [buffer, stats] = await Promise.all([fs.readFile(resolved.path), fs.stat(resolved.path)]);
  const text = decodeUtf8(buffer);
  return {
    path: resolved.relativePath,
    size: buffer.byteLength,
    modifiedAt: stats.mtime.toISOString(),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    encoding: text === undefined ? "base64" : "utf8",
    content: text ?? buffer.toString("base64"),
  };
}

function decodeWriteContent(content: string, encoding: "utf8" | "base64"): Buffer {
  if (encoding === "utf8") {
    return Buffer.from(content, "utf8");
  }
  const compact = content.replace(/\s+/gu, "");
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64").replace(/=+$/u, "") !== compact.replace(/=+$/u, "")) {
    throw new CentralFigureInputError("Figure content is not valid base64");
  }
  return decoded;
}

export async function writeCentralFigure(
  root: string,
  relativePath: string,
  content: string,
  encoding: "utf8" | "base64",
): Promise<CentralFigureReadResult> {
  const target = await prepareWritableFile(root, relativePath);
  await writeTextFile(target.path, decodeWriteContent(content, encoding));
  return await readCentralFigure(root, target.relativePath);
}

/**
 * Create one new authored TikZ source file without replacing an existing
 * figure. The `.tikz` extension is part of this operation's domain contract,
 * not merely an HTTP-schema convenience, so every caller gets the same rule.
 */
export async function createCentralTikzFigure(
  root: string,
  relativePath: string,
  content: string,
): Promise<CentralFigureReadResult> {
  if (!relativePath.endsWith(".tikz")) {
    throw new CentralFigureInputError("Created figure files must use the .tikz extension");
  }

  const target = await prepareWritableFile(root, relativePath);
  const temporary = `${target.path}.zettlr-create-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    try {
      // A hard-link publish is atomic and, unlike rename(), cannot replace an
      // existing destination. The temporary file lives beside the target, so
      // the link is guaranteed to stay on the same filesystem.
      await fs.link(temporary, target.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CentralFigureAlreadyExistsError(
          `Figure file already exists: ${target.relativePath}`,
        );
      }
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return await readCentralFigure(root, target.relativePath);
}

export async function searchCentralFigures(
  root: string,
  query: string,
): Promise<CentralFigureSearchResult> {
  const needle = query.toLocaleLowerCase("en-US");
  const { entries, notListed } = await listCentralFigures(root);
  const notSearched = [...notListed];
  const hits: CentralFigureSearchHit[] = [];
  let truncated = false;
  const push = (hit: CentralFigureSearchHit): boolean => {
    if (hits.length >= SEARCH_HIT_LIMIT) {
      truncated = true;
      return false;
    }
    hits.push(hit);
    return true;
  };

  for (const entry of entries) {
    if (entry.path.toLocaleLowerCase("en-US").includes(needle)) {
      if (!push({ path: entry.path, matchType: "path", excerpt: entry.path })) {
        break;
      }
    }
    if (entry.kind !== "file" || entry.size > SEARCH_FILE_LIMIT) {
      continue;
    }
    let file: CentralFigureReadResult;
    try {
      file = await readCentralFigure(root, entry.path);
    } catch (error) {
      notSearched.push({ path: entry.path, cause: causeOf(error as NodeJS.ErrnoException) });
      continue;
    }
    if (file.encoding !== "utf8") {
      continue;
    }
    const lines = file.content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLocaleLowerCase("en-US").includes(needle)) {
        continue;
      }
      if (
        !push({
          path: entry.path,
          matchType: "content",
          line: index + 1,
          excerpt: lines[index].trim(),
        })
      ) {
        break;
      }
    }
    if (truncated) {
      break;
    }
  }
  return { hits, truncated, notSearched };
}

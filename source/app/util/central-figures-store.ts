/**
 * Filesystem owner for the centralized authoring figure tree. API clients use
 * relative paths only; containment and symlink checks happen here before any
 * file bytes are read or written.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

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

export interface CentralFigureSearchResult {
  hits: CentralFigureSearchHit[];
  truncated: boolean;
}

const SEARCH_FILE_LIMIT = 2 * 1024 * 1024;
const SEARCH_HIT_LIMIT = 500;

export class CentralFigureInputError extends Error {}
export class CentralFigureNotFoundError extends Error {}
export class CentralFigureAlreadyExistsError extends Error {}

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
  const environment = env.FIGURES_SOURCE_DIR?.trim() ?? "";
  if (environment !== "") {
    return path.resolve(expandHome(environment, homeDirectory));
  }
  return path.join(homeDirectory, ".pandoc", "figures");
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

async function rootRealPath(root: string, create: boolean): Promise<string> {
  if (create) {
    await fs.mkdir(root, { recursive: true });
  }
  return await fs.realpath(root);
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CentralFigureInputError(
      "Figure path is outside the configured figures directory",
    );
  }
}

async function resolveExistingFile(
  root: string,
  relativePath: string,
): Promise<{ root: string; path: string; relativePath: string }> {
  const normalized = normalizeRelativePath(relativePath);
  let realRoot: string;
  try {
    realRoot = await rootRealPath(root, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CentralFigureNotFoundError(`Figure file not found: ${normalized}`);
    }
    throw error;
  }
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
  const segments = normalized.split("/");
  let directory = realRoot;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(directory, segment);
    try {
      const stats = await fs.lstat(next);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new CentralFigureInputError(
          `Figure folder ${segment} is not a directory`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(next);
    }
    directory = next;
  }
  const target = path.join(directory, segments.at(-1) ?? "");
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

export async function listCentralFigures(root: string): Promise<CentralFigureEntry[]> {
  let realRoot: string;
  try {
    realRoot = await rootRealPath(root, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const result: CentralFigureEntry[] = [];
  const queue: Array<{ absolute: string; relative: string }> = [
    { absolute: realRoot, relative: "" },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const entries = await fs.readdir(current.absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
      const stats = await fs.lstat(absolute);
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
  return result;
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
  const bytes = decodeWriteContent(content, encoding);
  const temporary = `${target.path}.zettlr-write-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, target.path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
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
  const entries = await listCentralFigures(root);
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
    } catch {
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
  return { hits, truncated };
}

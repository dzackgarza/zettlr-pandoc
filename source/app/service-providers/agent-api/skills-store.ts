/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Read-only configured skills-directory access
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Owns read-only access to the user-configured skills directory and exposes
 *                  only its physical directory subtree and Markdown files.
 *                  Relative paths, symlinks, and non-Markdown files cannot
 *                  cross or enlarge that capability boundary.
 *
 * END HEADER
 */

import { hasErrnoCode } from "@common/util/is-errno-exception";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";

export class SkillsDirectoryUnavailableError extends Error {}
export class SkillsPathInputError extends Error {}
export class SkillFileNotFoundError extends Error {}

export interface SkillTreeEntry {
  path: string;
  kind: "directory" | "markdown";
  size: number;
  modifiedAt: string;
}

export interface SkillMarkdownFile {
  root: string;
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  content: string;
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") {
    return homeDirectory;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

export function resolveSkillsDirectory(
  configuredDirectory: string | null | undefined,
  homeDirectory: string,
): string {
  const configured =
    configuredDirectory === null || configuredDirectory === undefined
      ? ""
      : configuredDirectory.trim();
  if (configured === "") {
    throw new SkillsDirectoryUnavailableError(
      "No skills directory is configured; set agentApi.skillsDirectory to an absolute path",
    );
  }
  const expanded = expandHome(configured, homeDirectory);
  if (!path.isAbsolute(expanded)) {
    throw new SkillsDirectoryUnavailableError(
      "agentApi.skillsDirectory must be an absolute path or start with '~/'",
    );
  }
  return path.resolve(expanded);
}

function normalizeRelativePath(value: string): string {
  if (value.includes("\0")) {
    throw new SkillsPathInputError("Skill path contains a NUL byte");
  }
  const unix = value.replaceAll("\\", "/");
  if (unix === "" || unix.startsWith("/") || /^[A-Za-z]:\//u.test(unix)) {
    throw new SkillsPathInputError("Skill path must be a non-empty relative path");
  }
  const segments = unix.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SkillsPathInputError("Skill path must not contain empty, '.' or '..' components");
  }
  return segments.join("/");
}

function isMarkdownPath(value: string): boolean {
  return path.extname(value).toLocaleLowerCase("en-US") === ".md";
}

async function realSkillsRoot(root: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch (error) {
    throw new SkillsDirectoryUnavailableError(
      `Configured skills directory is unavailable: ${root}`,
      { cause: error },
    );
  }
  const stats = await fs.stat(realRoot);
  if (!stats.isDirectory()) {
    throw new SkillsDirectoryUnavailableError(`Configured skills path is not a directory: ${root}`);
  }
  return realRoot;
}

async function validateSkillPathEntry(
  absolutePath: string,
  normalizedPath: string,
  isLast: boolean,
): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new SkillFileNotFoundError(`Skill file not found: ${normalizedPath}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new SkillsPathInputError("Skill paths may not traverse symbolic links");
  }
  if (isLast) {
    if (!stats.isFile()) {
      throw new SkillsPathInputError("Skill path does not name a Markdown file");
    }
    return;
  }
  if (!stats.isDirectory()) {
    throw new SkillFileNotFoundError(`Skill file not found: ${normalizedPath}`);
  }
}

async function resolveMarkdownFile(
  root: string,
  relativePath: string,
): Promise<{ root: string; path: string; relativePath: string }> {
  const normalized = normalizeRelativePath(relativePath);
  if (!isMarkdownPath(normalized)) {
    throw new SkillsPathInputError("Skill reads are restricted to .md Markdown files");
  }
  const realRoot = await realSkillsRoot(root);
  const segments = normalized.split("/");
  let current = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    await validateSkillPathEntry(current, normalized, index === segments.length - 1);
  }
  return { root: realRoot, path: current, relativePath: normalized };
}

async function appendSkillTreeEntry(
  absolute: string,
  relative: string,
  entries: SkillTreeEntry[],
): Promise<boolean> {
  const stats = await fs.lstat(absolute);
  if (stats.isSymbolicLink()) {
    return false;
  }
  if (stats.isDirectory()) {
    entries.push({
      path: relative,
      kind: "directory",
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
    return true;
  }
  if (stats.isFile() && isMarkdownPath(relative)) {
    entries.push({
      path: relative,
      kind: "markdown",
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }
  return false;
}

export async function listSkillTree(
  root: string,
): Promise<{ root: string; entries: SkillTreeEntry[] }> {
  const realRoot = await realSkillsRoot(root);
  const entries: SkillTreeEntry[] = [];
  const queue: Array<{ absolute: string; relative: string }> = [
    { absolute: realRoot, relative: "" },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const children = await fs.readdir(current.absolute, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(current.absolute, child.name);
      const relative = current.relative === "" ? child.name : `${current.relative}/${child.name}`;
      if (await appendSkillTreeEntry(absolute, relative, entries)) {
        queue.push({ absolute, relative });
      }
    }
  }
  return { root: realRoot, entries };
}

export async function readSkillMarkdown(
  root: string,
  relativePath: string,
): Promise<SkillMarkdownFile> {
  const resolved = await resolveMarkdownFile(root, relativePath);
  const [buffer, stats] = await Promise.all([fs.readFile(resolved.path), fs.stat(resolved.path)]);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SkillsPathInputError(
      `Skill file is not valid UTF-8 Markdown: ${resolved.relativePath}`,
    );
  }
  return {
    root: resolved.root,
    path: resolved.relativePath,
    size: buffer.byteLength,
    modifiedAt: stats.mtime.toISOString(),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    content,
  };
}

/**
 * Resolve authored TeX resources against the same user-owned search roots as
 * the canonical Pandoc/LaTeX pipeline. This is intentionally a filesystem
 * resolver, not a TeX parser: dynamic filenames are reported as uncheckable.
 */

import { type Dirent, promises as fs } from "fs";
import os from "os";
import path from "path";

export type TexResourceKind = "input" | "graphics";

export interface TexResourceProbe {
  id: number;
  kind: TexResourceKind;
  path: string;
}

export interface TexResourceProbeRequest {
  sourcePath: string;
  projectRoots: string[];
  graphicRoots: string[];
  resources: TexResourceProbe[];
}

export interface TexResourceProbeResult {
  id: number;
  checkable: boolean;
  resolvedPath?: string;
}

interface SearchRoot {
  directory: string;
  recursive: boolean;
  graphicsOnly?: boolean;
}

const GRAPHICS_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".eps"] as const;
const RECURSIVE_INDEX_TTL_MS = 5_000;
const recursiveIndexCache = new Map<string, { createdAt: number; files: Promise<string[]> }>();

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
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

function texInputRoots(homeDirectory: string, env: NodeJS.ProcessEnv): SearchRoot[] {
  const roots: SearchRoot[] = [
    { directory: path.join(homeDirectory, ".pandoc", "styles"), recursive: true },
    { directory: path.join(homeDirectory, ".pandoc", "styles", "macros"), recursive: true },
    { directory: path.join(homeDirectory, ".pandoc", "macros"), recursive: true },
    { directory: path.join(homeDirectory, ".pandoc", "config"), recursive: true },
    { directory: path.join(homeDirectory, ".pandoc"), recursive: false },
    { directory: path.join(homeDirectory, ".pandoc", "figures"), recursive: false },
  ];

  for (const raw of (env.TEXINPUTS ?? "").split(path.delimiter)) {
    if (raw === "") {
      continue;
    } // empty means TeX's system-default search tree
    const recursive = raw.endsWith("//");
    const withoutRecursive = recursive ? raw.slice(0, -2) : raw;
    if (withoutRecursive === "") {
      continue;
    }
    roots.push({
      directory: path.resolve(expandHome(withoutRecursive, homeDirectory)),
      recursive,
    });
  }
  return roots;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function candidateNames(probe: TexResourceProbe): string[] {
  if (path.extname(probe.path) !== "") {
    return [probe.path];
  }
  if (probe.kind === "input") {
    return [probe.path, `${probe.path}.tex`];
  }
  return [probe.path, ...GRAPHICS_EXTENSIONS.map((extension) => probe.path + extension)];
}

function isStaticResourcePath(value: string): boolean {
  if (value.trim() === "") {
    return false;
  }
  // TeX expansion, shell variables, globs, URL-like schemes, and macro
  // parameters make static filesystem resolution non-authoritative.
  if (/[\\$#*?]/u.test(value)) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    return false;
  }
  return true;
}

async function recursiveFiles(root: string): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const cached = recursiveIndexCache.get(absoluteRoot);
  if (cached !== undefined && Date.now() - cached.createdAt < RECURSIVE_INDEX_TTL_MS) {
    return await cached.files;
  }

  const pending = (async (): Promise<string[]> => {
    const files: string[] = [];
    const queue = [absoluteRoot];
    while (queue.length > 0) {
      const directory = queue.shift();
      if (directory === undefined) {
        break;
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolute);
        } else if (entry.isFile()) {
          files.push(absolute);
        }
      }
    }
    return files;
  })();

  recursiveIndexCache.set(absoluteRoot, { createdAt: Date.now(), files: pending });
  return await pending;
}

async function resolveInRoot(root: SearchRoot, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const direct = path.resolve(root.directory, name);
    if (await isFile(direct)) {
      return direct;
    }
  }
  if (!root.recursive) {
    return undefined;
  }

  const files = await recursiveFiles(root.directory);
  for (const name of names) {
    const normalized = name.replaceAll("\\", "/").replace(/^\.\//u, "");
    const withSlash = `/${normalized}`;
    const basename = path.basename(normalized);
    const match = files.find((candidate) => {
      const unix = candidate.replaceAll(path.sep, "/");
      return (
        unix.endsWith(withSlash) ||
        (!normalized.includes("/") && path.basename(candidate) === basename)
      );
    });
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

/**
 * Resolve a batch so one lint pass shares root indexing across all resources.
 */
export async function resolveTexResources(
  request: TexResourceProbeRequest,
  homeDirectory = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<TexResourceProbeResult[]> {
  const sourceDirectory =
    request.sourcePath === "" ? "" : path.dirname(path.resolve(request.sourcePath));
  const projectRoots = request.projectRoots
    .filter((root) => request.sourcePath !== "" && pathIsWithin(request.sourcePath, root))
    .map((root) => path.resolve(root));

  const ordinaryRoots: SearchRoot[] = [
    ...(sourceDirectory === "" ? [] : [{ directory: sourceDirectory, recursive: false }]),
    ...projectRoots.map((directory) => ({ directory, recursive: false })),
    ...texInputRoots(homeDirectory, env),
  ];

  const graphicsRoots: SearchRoot[] = [];
  for (const rawRoot of request.graphicRoots) {
    if (!isStaticResourcePath(rawRoot)) {
      continue;
    }
    const bases = [sourceDirectory, ...projectRoots].filter(Boolean);
    for (const base of bases) {
      graphicsRoots.push({
        directory: path.resolve(base, rawRoot),
        recursive: false,
        graphicsOnly: true,
      });
    }
  }

  const results: TexResourceProbeResult[] = [];
  for (const probe of request.resources) {
    const authored = probe.path.trim();
    if (!isStaticResourcePath(authored)) {
      results.push({ id: probe.id, checkable: false });
      continue;
    }
    const names = candidateNames({ ...probe, path: authored });
    if (path.isAbsolute(authored)) {
      const resolved = await resolveInRoot(
        { directory: path.dirname(authored), recursive: false },
        names.map((name) => path.basename(name)),
      );
      results.push(
        resolved === undefined
          ? { id: probe.id, checkable: true }
          : { id: probe.id, checkable: true, resolvedPath: resolved },
      );
      continue;
    }

    const roots = probe.kind === "graphics" ? [...graphicsRoots, ...ordinaryRoots] : ordinaryRoots;
    let resolvedPath: string | undefined;
    for (const root of roots) {
      if (root.graphicsOnly === true && probe.kind !== "graphics") {
        continue;
      }
      resolvedPath = await resolveInRoot(root, names);
      if (resolvedPath !== undefined) {
        break;
      }
    }
    results.push(
      resolvedPath === undefined
        ? { id: probe.id, checkable: true }
        : { id: probe.id, checkable: true, resolvedPath },
    );
  }
  return results;
}

/** Test seam for filesystem fixtures that replace a cached recursive root. */
export function __resetTexResourceResolverCacheForTests(): void {
  recursiveIndexCache.clear();
}

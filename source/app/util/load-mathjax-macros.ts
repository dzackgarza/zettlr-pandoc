/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Canonical MathJax macro loader
 * CVM-Role:        Utility
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Loads the generated MathJax projection owned by the central
 *                  ~/.pandoc macro system. Production consumers must resolve
 *                  that projection from ~/.pandoc; the generic file loader is
 *                  retained only for explicit tests/fixtures.
 *
 * END HEADER
 */

import isFile from "@common/util/is-file";
import { type MathJaxMacro, parseMathJaxMacros } from "@common/util/mathjax-config";
import { texCommandDeclarations } from "@common/util/tex-command-declarations";
import { type Dirent, promises as fs } from "fs";
import path from "path";

export const MATHJAX_MACROS_FILENAME = "mathjax-macros.json";

const TEX_SOURCE_EXTENSIONS = new Set([".tex", ".sty", ".cls"]);

/** Resolve the generated MathJax projection owned by ~/.pandoc. */
export function canonicalMathJaxMacrosPath(homeDirectory: string): string {
  return path.join(homeDirectory, ".pandoc", "templates", "css", MATHJAX_MACROS_FILENAME);
}

/**
 * Load the central generated projection. Missing central configuration is a
 * configuration error: production must never fall back to a bundled/app-local
 * macro copy, because that creates a second semantic authority.
 */
export async function loadCanonicalMathJaxMacros(
  homeDirectory: string,
): Promise<Record<string, MathJaxMacro>> {
  const filePath = canonicalMathJaxMacrosPath(homeDirectory);
  if (!isFile(filePath)) {
    throw new Error(
      `MathJax macros require the central generated projection ${filePath}; ` +
        "run ~/.pandoc/bin/generate-mathjax-config.py from the canonical macro tree.",
    );
  }
  return await loadMathJaxMacros(filePath);
}

/**
 * Enumerate every user-declared control word in the canonical authoring macro
 * tree. Unlike the MathJax projection, this includes compiler-only macros whose
 * TeX definitions cannot be represented faithfully by MathJax.
 */
export async function loadCanonicalTexMacroCommands(homeDirectory: string): Promise<string[]> {
  const root = path.join(homeDirectory, ".pandoc", "styles", "macros");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`TeX macro diagnostics require the canonical authoring macro tree ${root}.`, {
      cause: error,
    });
  }

  const commands = new Set<string>();
  const queue: Array<{ directory: string; entries: Dirent[] }> = [{ directory: root, entries }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const entry of current.entries) {
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        queue.push({
          directory: absolute,
          entries: await fs.readdir(absolute, { withFileTypes: true }),
        });
        continue;
      }
      if (!entry.isFile() || !TEX_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const source = await fs.readFile(absolute, "utf8");
      for (const command of texCommandDeclarations(source)) {
        commands.add(command);
      }
    }
  }

  return [...commands].sort((a, b) => a.localeCompare(b));
}

/**
 * Reads and validates one explicit MathJax macro projection. Production uses
 * this only through `loadCanonicalMathJaxMacros`; accepting an arbitrary path
 * here is useful for isolated fixtures and projection tests. An absent explicit
 * fixture yields an empty map, while malformed content fails loudly.
 */
export async function loadMathJaxMacros(filePath: string): Promise<Record<string, MathJaxMacro>> {
  if (!isFile(filePath)) {
    return {};
  }

  const contents = await fs.readFile(filePath, { encoding: "utf8" });
  return parseMathJaxMacros(JSON.parse(contents));
}

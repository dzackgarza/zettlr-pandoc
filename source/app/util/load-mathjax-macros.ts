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

import isErrnoException from "@common/util/is-errno-exception";
import isFile from "@common/util/is-file";
import { type MathJaxMacro, parseMathJaxMacros } from "@dzack/tikz-render/mathjax-config";
import { texCommandDeclarationEntries } from "@dzack/tikz-render/tex-command-declarations";
import { type Dirent, promises as fs } from "fs";
import path from "path";

export const MATHJAX_MACROS_FILENAME = "mathjax-macros.json";

const TEX_SOURCE_EXTENSIONS = new Set([".tex", ".sty", ".cls"]);

export interface CanonicalMacroDeclaration {
  sourcePath: string;
  line: number;
  declaration: string;
  context: string;
}

export interface CanonicalMacroMathJaxDefinition {
  replacement: string;
  argumentCount: number;
  optionalDefault?: string;
}

export interface CanonicalMacroEntry {
  name: string;
  declarations: CanonicalMacroDeclaration[];
  mathjax?: CanonicalMacroMathJaxDefinition;
}

/** A path of the macro tree whose content the filesystem refuses, with the cause. */
export interface MacroSourceNotRead {
  path: string;
  cause: string;
}

export interface CanonicalMacroInventory {
  root: string;
  macros: CanonicalMacroEntry[];
  notRead: MacroSourceNotRead[];
}

/**
 * The macro tree of ~/.pandoc cannot be read, or its generated MathJax
 * projection cannot be read or is not a macro projection.
 */
export class MacroSourcesUnavailableError extends Error {}

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
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!isErrnoException(error)) throw error;
    throw new MacroSourcesUnavailableError(
      `Can't read the generated MathJax macro file ${filePath}: ${error.message}. ` +
        "Run ~/.pandoc/bin/generate-mathjax-config.py to rebuild it.",
      { cause: error },
    );
  }
  try {
    return parseMathJaxMacros(JSON.parse(contents));
  } catch (error) {
    // JSON.parse throws a SyntaxError and parseMathJaxMacros a TypeError for
    // text that is no macro projection.
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new MacroSourcesUnavailableError(
      `The generated MathJax macro file ${filePath} is not a macro projection: ${error.message}. ` +
        "Run ~/.pandoc/bin/generate-mathjax-config.py to rebuild it.",
      { cause: error },
    );
  }
}

/** The control words that the readable sources of the macro tree declare. */
export interface CanonicalTexMacroCommands {
  commands: string[];
  notRead: MacroSourceNotRead[];
}

/**
 * Enumerate every user-declared control word in the canonical authoring macro
 * tree. Unlike the MathJax projection, this includes compiler-only macros whose
 * TeX definitions cannot be represented faithfully by MathJax. A folder or a
 * source file whose content the filesystem refuses is in `notRead`; a root
 * that refuses its content is a MacroSourcesUnavailableError.
 */
export async function loadCanonicalTexMacroCommands(
  homeDirectory: string,
): Promise<CanonicalTexMacroCommands> {
  const tree = await readMacroTree(macroTreeRoot(homeDirectory));
  const commands = new Set(tree.declarations.map((entry) => entry.name));
  return {
    commands: [...commands].sort((a, b) => a.localeCompare(b)),
    notRead: tree.notRead,
  };
}

function macroTreeRoot(homeDirectory: string): string {
  return path.join(homeDirectory, ".pandoc", "styles", "macros");
}

interface MacroTree {
  declarations: Array<{ name: string; declaration: CanonicalMacroDeclaration }>;
  notRead: MacroSourceNotRead[];
}

/**
 * Reads each TeX source of the macro tree at `root`, in the order of the
 * names. A folder or a source file whose content the filesystem refuses is
 * in `notRead`, and its declarations are not read; a root that refuses its
 * content is a MacroSourcesUnavailableError.
 */
async function readMacroTree(root: string): Promise<MacroTree> {
  const declarations: MacroTree["declarations"] = [];
  const notRead: MacroSourceNotRead[] = [];
  const queue: string[] = [root];
  const relativeToRoot = (absolute: string): string =>
    path.relative(root, absolute).split(path.sep).join("/");

  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) {
      break;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isErrnoException(error)) throw error;
      if (directory === root) {
        throw new MacroSourcesUnavailableError(
          `Can't read the TeX macro directory ${root}: ${error.message}`,
          { cause: error },
        );
      }
      notRead.push({ path: relativeToRoot(directory), cause: error.message });
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !TEX_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const sourcePath = relativeToRoot(absolute);
      let source: string;
      try {
        source = await fs.readFile(absolute, "utf8");
      } catch (error) {
        if (!isErrnoException(error)) throw error;
        notRead.push({ path: sourcePath, cause: error.message });
        continue;
      }
      for (const command of texCommandDeclarationEntries(source)) {
        declarations.push({
          name: command.name,
          declaration: {
            sourcePath,
            line: command.line,
            declaration: command.declaration,
            context: command.context,
          },
        });
      }
    }
  }

  return { declarations, notRead };
}

function mathJaxDefinition(definition: MathJaxMacro): CanonicalMacroMathJaxDefinition {
  if (typeof definition === "string") {
    return { replacement: definition, argumentCount: 0 };
  }
  const [replacement, argumentCount, optionalDefault] = definition;
  return optionalDefault === undefined
    ? { replacement, argumentCount }
    : { replacement, argumentCount, optionalDefault };
}

/**
 * Inspect the complete canonical user macro vocabulary. Compiler-only TeX
 * declarations and MathJax-projected declarations are merged by control word;
 * duplicate authored declarations are deliberately preserved. A folder or a
 * source file whose content the filesystem refuses is in `notRead`, and its
 * declarations are not in the inventory; a root that refuses its content is
 * a MacroSourcesUnavailableError.
 */
export async function loadCanonicalMacroInventory(
  homeDirectory: string,
): Promise<CanonicalMacroInventory> {
  const root = macroTreeRoot(homeDirectory);
  const tree = await readMacroTree(root);
  const declarations = Map.groupBy(tree.declarations, (entry) => entry.name);
  const projected = await loadCanonicalMathJaxMacros(homeDirectory);
  const names = new Set([
    ...declarations.keys(),
    ...Object.keys(projected).map((name) => `\\${name}`),
  ]);
  const macros = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name): CanonicalMacroEntry => {
      const projection = projected[name.slice(1)];
      // A macro the MathJax projection defines but no TeX source declares has
      // no declarations to report.
      const declared = declarations.get(name);
      return {
        name,
        declarations: declared === undefined ? [] : declared.map((entry) => entry.declaration),
        ...(projection === undefined ? {} : { mathjax: mathJaxDefinition(projection) }),
      };
    });

  return { root, macros, notRead: tree.notRead };
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

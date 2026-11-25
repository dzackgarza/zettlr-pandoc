import isErrnoException from "@common/util/is-errno-exception";
import isFile from "@common/util/is-file";
import {
  type MathJaxMacro,
  parseMathJaxMacros,
} from "@dzack/tikz-render/mathjax-config";
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

export interface MacroSourceNotRead {
  path: string;
  cause: string;
}

export interface CanonicalMacroInventory {
  root: string;
  macros: CanonicalMacroEntry[];
  notRead: MacroSourceNotRead[];
}

export class MacroSourcesUnavailableError extends Error {}

export function canonicalMathJaxMacrosPath(homeDirectory: string): string {
  return path.join(homeDirectory, ".pandoc", "templates", "css", MATHJAX_MACROS_FILENAME);
}


async function loadGeneratedProjection<T>(
  filePath: string,
  what: string,
  parse: (data: unknown) => T,
): Promise<T> {
  const rebuild = "Run `just --justfile ~/.pandoc/justfile generate-math-macros` to rebuild it.";
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!isErrnoException(error)) throw error;
    throw new MacroSourcesUnavailableError(
      `Can't read the generated MathJax ${what} file ${filePath}: ${error.message}. ${rebuild}`,
      { cause: error },
    );
  }
  try {
    return parse(JSON.parse(contents));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new MacroSourcesUnavailableError(
      `The generated MathJax ${what} file ${filePath} is not a ${what} projection: ${error.message}. ${rebuild}`,
      { cause: error },
    );
  }
}

export async function loadCanonicalMathJaxMacros(
  homeDirectory: string,
): Promise<Record<string, MathJaxMacro>> {
  return await loadGeneratedProjection(
    canonicalMathJaxMacrosPath(homeDirectory),
    "macro",
    parseMathJaxMacros,
  );
}


export interface CanonicalTexMacroCommands {
  commands: string[];
  notRead: MacroSourceNotRead[];
}

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
      const declared = declarations.get(name);
      return {
        name,
        declarations: declared === undefined ? [] : declared.map((entry) => entry.declaration),
        ...(projection === undefined ? {} : { mathjax: mathJaxDefinition(projection) }),
      };
    });

  return { root, macros, notRead: tree.notRead };
}

export async function loadMathJaxMacros(filePath: string): Promise<Record<string, MathJaxMacro>> {
  if (!isFile(filePath)) {
    return {};
  }

  const contents = await fs.readFile(filePath, { encoding: "utf8" });
  return parseMathJaxMacros(JSON.parse(contents));
}

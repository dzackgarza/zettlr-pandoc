import { texCommandDeclarationEntries } from "@dzack/tikz-render/tex-command-declarations";
import type { Tree } from "@lezer/common";
import YAML from "yaml";
import { firstMetadataBlock, type MetadataBlockRange } from "./document-frontmatter";
import type { TexstudioCommandIndex } from "./texstudio-command-index";

export type TexDocumentKind = "markdown" | "latex" | "yaml";

/**
 * A document whose TeX the completion reads. A Markdown document carries its
 * metadata block (`firstMetadataBlock` of its syntax tree), the block that
 * Pandoc and the descriptor of the file read.
 */
export type TexDocument =
  | { kind: "markdown"; source: string; metadata: MetadataBlockRange | null }
  | { kind: "latex" | "yaml"; source: string };

/** The TeX document of a text of `kind` and its syntax tree. */
export function texDocument(source: string, kind: TexDocumentKind, tree: Tree): TexDocument {
  return kind === "markdown"
    ? { kind, source, metadata: firstMetadataBlock(tree) }
    : { kind, source };
}

export interface TexMacroSource {
  path: string;
  content: string;
}

export interface TexContextDeclaration {
  packages: string[];
  classes: string[];
  macroSources: string[];
  userCommands: string[];
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function frontmatterObject(document: TexDocument): Record<string, unknown> | undefined {
  let yamlSource = document.source;
  if (document.kind === "markdown") {
    if (document.metadata === null) {
      return undefined;
    }
    yamlSource = document.source.slice(document.metadata.bodyFrom, document.metadata.bodyTo);
  } else if (document.kind !== "yaml") {
    return undefined;
  }

  try {
    const parsed: unknown = YAML.parse(yamlSource);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function explicitTexContext(document: TexDocument): {
  packages: string[];
  classes: string[];
  macroSources: string[];
} {
  const root = frontmatterObject(document);
  const tex = root?.tex;
  if (typeof tex !== "object" || tex === null || Array.isArray(tex)) {
    return { packages: [], classes: [], macroSources: [] };
  }
  const record = tex as Record<string, unknown>;
  return {
    packages: stringList(record.packages),
    classes: stringList(record.classes),
    macroSources: stringList(record.macro_sources),
  };
}

export function declaredTexMacroSources(document: TexDocument): string[] {
  return explicitTexContext(document).macroSources;
}

/**
 * Masks ordinary Markdown code while retaining Pandoc raw-LaTeX code spans and
 * fenced raw blocks. Package declarations inside examples must not activate a
 * completion provider; declarations inside authored raw TeX must.
 */
function maskLine(line: string): string {
  return " ".repeat(line.length);
}

function maskNonNewlines(source: string): string {
  return source.replace(/[^\r\n]/gu, " ");
}

/**
 * Keeps only YAML's header-includes value at the same source positions. Other
 * YAML strings may legitimately contain backslashes (for example paths) and
 * must never be interpreted as TeX commands.
 */
function yamlHeaderIncludesSurface(source: string): string {
  const lines = source.split("\n");
  let headerIndent: number | undefined;

  return lines
    .map((line) => {
      const match = /^(\s*)header-includes\s*:(.*)$/u.exec(line);
      if (headerIndent === undefined) {
        if (match === null) {
          return maskNonNewlines(line);
        }
        headerIndent = match[1].length;
        return line;
      }

      if (line.trim() === "") {
        return maskNonNewlines(line);
      }

      const indentation = line.length - line.trimStart().length;
      if (indentation > headerIndent) {
        return line;
      }

      headerIndent = undefined;
      if (match !== null) {
        headerIndent = match[1].length;
        return line;
      }
      return maskNonNewlines(line);
    })
    .join("\n");
}

function maskMarkdownFrontmatter(source: string, metadata: MetadataBlockRange | null): string {
  if (metadata === null) {
    return source;
  }
  const { from, to, bodyFrom, bodyTo } = metadata;
  return (
    source.slice(0, from) +
    maskNonNewlines(source.slice(from, bodyFrom)) +
    yamlHeaderIncludesSurface(source.slice(bodyFrom, bodyTo)) +
    maskNonNewlines(source.slice(bodyTo, to)) +
    source.slice(to)
  );
}

function markdownTexSurface(source: string, metadata: MetadataBlockRange | null): string {
  // Split only on LF so a CR in CRLF-loaded content remains at its original
  // document offset. Every masking operation below is length preserving.
  const lines = maskMarkdownFrontmatter(source, metadata).split("\n");
  let fence: { marker: string; rawTex: boolean } | undefined;
  const retained = lines
    .map((line) => {
      const fenceMatch = /^ {0,3}((?:\x60{3,}|~{3,}))(.*)$/u.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1];
        if (fence === undefined) {
          const info = fenceMatch[2].trim().toLowerCase();
          fence = {
            marker,
            rawTex: /^\{=\s*(?:latex|tex)(?:\s+[^}]*)?\}$/u.test(info),
          };
          return fence.rawTex ? line : maskLine(line);
        }
        if (
          marker[0] === fence.marker[0] &&
          marker.length >= fence.marker.length &&
          fenceMatch[2].trim() === ""
        ) {
          const wasRaw = fence.rawTex;
          fence = undefined;
          return wasRaw ? line : maskLine(line);
        }
      }
      if (fence !== undefined && !fence.rawTex) {
        return maskLine(line);
      }
      return line;
    })
    .join("\n");

  // Preserve Pandoc raw inline TeX and mask ordinary inline code.
  return retained.replace(
    /(\x60+)([^\n]*?)\1(\{=\s*(?:latex|tex)\s*\})?/giu,
    (whole, _ticks, _body, raw) => {
      return raw === undefined ? " ".repeat(whole.length) : whole;
    },
  );
}

/** A same-length view of the source containing only TeX-significant regions. */
export function texCommandSurface(document: TexDocument): string {
  switch (document.kind) {
    case "markdown":
      return stripTexComments(markdownTexSurface(document.source, document.metadata));
    case "yaml":
      return stripTexComments(yamlHeaderIncludesSurface(document.source));
    case "latex":
      return stripTexComments(document.source);
  }
}

export function texCommandMayStartAt(source: string, from: number): boolean {
  if (from === 0) {
    return true;
  }
  // Avoid treating path fragments and identifier escapes as raw TeX. A TeX
  // control sequence in Markdown starts at a token boundary, not after a path
  // separator, drive-colon, identifier character, or another backslash.
  return !/[A-Za-z0-9_:/\\]/u.test(source[from - 1]);
}

/** Removes unescaped TeX comments without changing line boundaries. */
function stripTexComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      for (let index = 0; index < line.length; index++) {
        if (line[index] !== "%") {
          continue;
        }
        let slashes = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) {
          slashes++;
        }
        if (slashes % 2 === 0) {
          return line.slice(0, index) + " ".repeat(line.length - index);
        }
      }
      return line;
    })
    .join("\n");
}

function scanTexSource(source: string): {
  packages: string[];
  classes: string[];
  userCommands: string[];
} {
  const packages = new Set<string>();
  const classes = new Set<string>();
  const userCommands = new Set<string>();
  const uncommented = stripTexComments(source);

  for (const match of uncommented.matchAll(
    /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/gu,
  )) {
    for (const packageName of match[1].split(",")) {
      if (packageName.trim() !== "") {
        packages.add(packageName.trim());
      }
    }
  }
  for (const match of uncommented.matchAll(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/gu)) {
    for (const className of match[1].split(",")) {
      if (className.trim() !== "") {
        classes.add(className.trim());
      }
    }
  }

  // The one reader of TeX declarations, which the macro inventory uses too
  for (const declaration of texCommandDeclarationEntries(uncommented)) {
    userCommands.add(declaration.name);
  }

  return {
    packages: [...packages],
    classes: [...classes],
    userCommands: [...userCommands],
  };
}

function providerName(name: string): string {
  return name.trim().replace(/\.(?:cwl|sty|cls)$/iu, "");
}

function classProviderName(name: string, index: TexstudioCommandIndex): string {
  const normalized = providerName(name);
  const className = "class-" + normalized;
  return index.p[className] === undefined ? normalized : className;
}

/**
 * Extracts the package/class roots and user-defined commands that determine
 * TeX completion validity. Additional macro sources are supplied by the host
 * through Zettlr's document authority; this common module never reads files.
 */
export function collectTexContext(
  index: TexstudioCommandIndex,
  document: TexDocument,
  macroSources: readonly TexMacroSource[] = [],
): TexContextDeclaration {
  const visible = texCommandSurface(document);
  const scanned = scanTexSource(visible);
  const explicit = explicitTexContext(document);
  const packages = new Set<string>([
    ...scanned.packages.map(providerName),
    ...explicit.packages.map(providerName),
  ]);
  const classes = new Set<string>([
    ...scanned.classes.map((name) => classProviderName(name, index)),
    ...explicit.classes.map((name) => classProviderName(name, index)),
  ]);
  const userCommands = new Set<string>(scanned.userCommands);

  for (const macroSource of macroSources) {
    if (!/\.(?:tex|sty|cls)$/iu.test(macroSource.path)) {
      continue;
    }
    const sourceContext = scanTexSource(macroSource.content);
    for (const packageName of sourceContext.packages) {
      packages.add(providerName(packageName));
    }
    for (const className of sourceContext.classes) {
      classes.add(classProviderName(className, index));
    }
    for (const command of sourceContext.userCommands) {
      userCommands.add(command);
    }
  }

  return {
    packages: [...packages].sort(),
    classes: [...classes].sort(),
    macroSources: [...new Set(explicit.macroSources)].sort(),
    userCommands: [...userCommands].sort(),
  };
}

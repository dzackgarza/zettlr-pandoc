import type { TexstudioCommandIndex } from "@dts/common/tex-vocabulary";
import { texCommandDeclarationEntries } from "@dzack/tikz-render/tex-command-declarations";
import type { Tree } from "@lezer/common";
import { firstMetadataBlock, type MetadataBlockRange } from "./document-frontmatter";

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

/**
 * The TeX of a document as the completion reads it: the index entries that
 * its declarations load, and the commands that it defines.
 */
export interface TexContextDeclaration {
  roots: string[];
  userCommands: string[];
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

// Flowmark's `_PACKAGE_DECLARATION` and `_DOCUMENT_CLASS_DECLARATION`
// (lint_authoring.py): a package declaration loads each name of its list, a
// class declaration loads one name.
const PACKAGE_DECLARATION =
  /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{(?<names>[^{}]+)\}/gu;
const DOCUMENT_CLASS_DECLARATION = /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{(?<name>[^{}]+)\}/gu;

/**
 * The index entries that a declaration loads: a package by its name, a class
 * as `class-<name>` when the index has that entry and by its name otherwise.
 * Flowmark's `_texstudio_roots`.
 */
function declaredRoots(source: string, index: TexstudioCommandIndex): Set<string> {
  const roots = new Set<string>();
  for (const match of source.matchAll(PACKAGE_DECLARATION)) {
    for (const name of match.groups!.names.split(",")) {
      if (name.trim() !== "") {
        roots.add(name.trim());
      }
    }
  }
  for (const match of source.matchAll(DOCUMENT_CLASS_DECLARATION)) {
    const name = match.groups!.name.trim();
    if (name !== "") {
      const className = `class-${name}`;
      roots.add(index.packages[className] === undefined ? name : className);
    }
  }
  return roots;
}

/** The index entries that the TeX of the document loads, and the commands it defines. */
export function collectTexContext(
  index: TexstudioCommandIndex,
  document: TexDocument,
): TexContextDeclaration {
  const visible = texCommandSurface(document);
  // The one reader of TeX declarations, which the macro inventory uses too
  const userCommands = new Set(
    texCommandDeclarationEntries(visible).map((declaration) => declaration.name),
  );
  return {
    roots: [...declaredRoots(visible, index)].sort(),
    userCommands: [...userCommands].sort(),
  };
}

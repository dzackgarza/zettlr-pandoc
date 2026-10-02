/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ-cd ↔ Quiver editor bridge domain
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Owns the source/range contract between a Markdown tikzcd
 *                  block and the vendored Quiver editor. UI code consumes
 *                  these pure helpers; it never reimplements wrapper parsing
 *                  or range arithmetic.
 *
 * END HEADER
 */

import type { TikzSourceBlock } from "./source-block";

export interface QuiverEditableBlock extends TikzSourceBlock {
  authoredSource: string;
}

export interface TikzQuiverSourceSession {
  kind: "raw" | "fence";
  blockFrom: number;
  blockTo: number;
  sourceFrom: number;
  sourceTo: number;
  /** Exact source bytes currently stored in [sourceFrom, sourceTo). */
  source: string;
  /** Markdown bytes in that range, including list or quote prefixes. */
  authoredSource: string;
  /** Exact separator between semantic lines in the Markdown document. */
  lineJoiner: string;
}

type QuiverLineMapping = { ok: true; lineJoiner: string } | { ok: false; reason: string };

function lineMappingForBlock(block: QuiverEditableBlock): QuiverLineMapping {
  const lines = block.source.split("\n");
  const ranges = block.sourceLineRanges;
  if (ranges.length !== lines.length) {
    return {
      ok: false,
      reason: `The TikZ-cd parser mapped ${ranges.length} source lines, but the diagram has ${lines.length} lines.`,
    };
  }
  if (block.authoredSource.length !== block.sourceTo - block.sourceFrom) {
    return {
      ok: false,
      reason: `The Markdown source range has ${block.sourceTo - block.sourceFrom} characters, but the editor supplied ${block.authoredSource.length}.`,
    };
  }
  if (ranges[0].from !== block.sourceFrom || ranges[ranges.length - 1].to !== block.sourceTo) {
    return {
      ok: false,
      reason: "The TikZ-cd source line boundaries differ from the Markdown source range.",
    };
  }
  let joiner = "\n";
  for (let index = 1; index < ranges.length; index += 1) {
    const gap = block.authoredSource.slice(
      ranges[index - 1].to - block.sourceFrom,
      ranges[index].from - block.sourceFrom,
    );
    if (!gap.startsWith("\n")) {
      return {
        ok: false,
        reason: `Diagram line ${index + 1} has no mapped line break before its TikZ-cd source.`,
      };
    }
    if (index > 1 && gap !== joiner) {
      return {
        ok: false,
        reason: `Diagram line ${index + 1} uses Markdown prefix ${JSON.stringify(gap.slice(1))}; the preceding diagram lines use ${JSON.stringify(joiner.slice(1))}.`,
      };
    }
    joiner = gap;
  }
  if (lines.join(joiner) !== block.authoredSource) {
    return {
      ok: false,
      reason: "The parsed TikZ-cd source does not match the Markdown text at its mapped positions.",
    };
  }
  return { ok: true, lineJoiner: joiner };
}

export function quiverSourceError(block: QuiverEditableBlock): string | null {
  if (block.language !== "tikzcd")
    return `Quiver edits tikzcd diagrams; this block is ${block.language}.`;
  const mapping = lineMappingForBlock(block);
  return mapping.ok ? null : mapping.reason;
}

export function quiverCanEditBlock(block: QuiverEditableBlock): boolean {
  return quiverSourceError(block) === null;
}

export function quiverSessionForBlock(block: QuiverEditableBlock): TikzQuiverSourceSession {
  if (block.language !== "tikzcd")
    throw new Error(`Quiver edits tikzcd diagrams; this block is ${block.language}.`);
  const mapping = lineMappingForBlock(block);
  if (!mapping.ok) throw new Error(mapping.reason);
  return {
    kind: block.kind,
    blockFrom: block.from,
    blockTo: block.to,
    sourceFrom: block.sourceFrom,
    sourceTo: block.sourceTo,
    source: block.source,
    authoredSource: block.authoredSource,
    lineJoiner: mapping.lineJoiner,
  };
}

/** Source handed to Quiver's native tikz-cd parser. */
export function quiverSourceForSession(session: TikzQuiverSourceSession): string {
  return session.kind === "raw"
    ? session.source
    : `\\begin{tikzcd}\n${session.source}\n\\end{tikzcd}`;
}

/**
 * Convert Quiver's canonical full environment back to the bytes owned by the
 * Markdown block. A ```tikzcd fence owns only its body; its hidden wrapper has
 * no place to encode environment-level options, so refusing such an export is
 * safer than silently dropping those semantics.
 */
export function sourceForQuiverExport(session: TikzQuiverSourceSession, exported: string): string {
  const source = exported.trim();
  if (session.kind === "raw") {
    return source;
  }

  const match = /^\\begin\{tikzcd\}[ \t]*\r?\n([\s\S]*?)\r?\n\\end\{tikzcd\}$/u.exec(source);
  if (match === null) {
    throw new Error(
      "This fenced tikzcd block cannot store the options Quiver added. " +
        "Use a \\begin{tikzcd} ... \\end{tikzcd} block instead.",
    );
  }
  return match[1];
}

export interface TikzQuiverReplacement {
  from: number;
  to: number;
  insert: string;
  next: TikzQuiverSourceSession;
}

/** Pure range update for one Quiver-originated source replacement. */
export function quiverReplacement(
  session: TikzQuiverSourceSession,
  exported: string,
): TikzQuiverReplacement {
  const insert = sourceForQuiverExport(session, exported);
  const authoredInsert = insert.split("\n").join(session.lineJoiner);
  const delta = authoredInsert.length - session.authoredSource.length;
  return {
    from: session.sourceFrom,
    to: session.sourceTo,
    insert: authoredInsert,
    next: {
      ...session,
      blockTo: session.blockTo + delta,
      sourceTo: session.sourceTo + delta,
      source: insert,
      authoredSource: authoredInsert,
    },
  };
}

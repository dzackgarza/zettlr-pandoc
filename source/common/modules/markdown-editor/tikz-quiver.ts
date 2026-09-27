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

import type { TikzSourceBlock } from "./tikz-block";

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

function lineJoinerForBlock(block: QuiverEditableBlock): string | null {
  const lines = block.source.split("\n");
  const ranges = block.sourceLineRanges;
  if (ranges.length !== lines.length || block.authoredSource.length !== block.sourceTo - block.sourceFrom) {
    return null;
  }
  if (ranges[0].from !== block.sourceFrom || ranges[ranges.length - 1].to !== block.sourceTo) {
    return null;
  }
  let joiner = "\n";
  for (let index = 1; index < ranges.length; index += 1) {
    const gap = block.authoredSource.slice(
      ranges[index - 1].to - block.sourceFrom,
      ranges[index].from - block.sourceFrom,
    );
    if (!gap.startsWith("\n") || (index > 1 && gap !== joiner)) {
      return null;
    }
    joiner = gap;
  }
  return lines.join(joiner) === block.authoredSource ? joiner : null;
}

export function quiverCanEditBlock(block: QuiverEditableBlock): boolean {
  return block.language === "tikzcd" && lineJoinerForBlock(block) !== null;
}

export function quiverSessionForBlock(block: QuiverEditableBlock): TikzQuiverSourceSession {
  if (block.language !== "tikzcd") {
    throw new Error(`Quiver can only edit tikzcd diagrams, not ${block.language}`);
  }
  const lineJoiner = lineJoinerForBlock(block);
  if (lineJoiner === null) {
    throw new Error(
      "Quiver cannot preserve this diagram's Markdown line prefixes",
    );
  }
  return {
    kind: block.kind,
    blockFrom: block.from,
    blockTo: block.to,
    sourceFrom: block.sourceFrom,
    sourceTo: block.sourceTo,
    source: block.source,
    authoredSource: block.authoredSource,
    lineJoiner,
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

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

import { type TikzSourceBlock, tikzBlockHasContiguousSource } from "./tikz-block";

export interface TikzQuiverSourceSession {
  kind: "raw" | "fence";
  blockFrom: number;
  blockTo: number;
  sourceFrom: number;
  sourceTo: number;
  /** Exact source bytes currently stored in [sourceFrom, sourceTo). */
  source: string;
}

export function quiverSessionForBlock(block: TikzSourceBlock): TikzQuiverSourceSession {
  if (block.language !== "tikzcd") {
    throw new Error(`Quiver sessions require tikzcd source, received ${block.language}`);
  }
  if (!tikzBlockHasContiguousSource(block)) {
    throw new Error(
      "Quiver cannot rewrite a raw tikzcd block whose semantic source crosses Markdown container markers",
    );
  }
  return {
    kind: block.kind,
    blockFrom: block.from,
    blockTo: block.to,
    sourceFrom: block.sourceFrom,
    sourceTo: block.sourceTo,
    source: block.source,
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
      "Quiver exported a fenced tikzcd diagram with wrapper syntax that the fence body cannot represent. " +
        "Switch to TikZ source mode and use a raw \\begin{tikzcd} environment for environment-level options.",
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
  const delta = insert.length - session.source.length;
  return {
    from: session.sourceFrom,
    to: session.sourceTo,
    insert,
    next: {
      ...session,
      blockTo: session.blockTo + delta,
      sourceTo: session.sourceTo + delta,
      source: insert,
    },
  };
}

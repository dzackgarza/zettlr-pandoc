/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        tikz-editor iframe source bridge domain
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Owns the exact source/range contract between one authored
 *                  ordinary TikZ block and the vendored tikz-editor iframe.
 *                  Zettlr does not parse or canonicalize the TikZ here: the
 *                  complete current bytes are handed to tikz-editor and its
 *                  complete edited bytes replace only the active block.
 *
 * END HEADER
 */

import { type TikzSourceBlock, tikzBlockHasContiguousSource } from "./tikz-block";

export interface TikzEditorSourceSession {
  kind: "raw" | "fence";
  blockFrom: number;
  blockTo: number;
  sourceFrom: number;
  sourceTo: number;
  /** Exact source bytes currently stored in [sourceFrom, sourceTo). */
  source: string;
}

export function tikzEditorSessionForBlock(block: TikzSourceBlock): TikzEditorSourceSession {
  if (block.language !== "tikz") {
    throw new Error(
      `tikz-editor sessions require ordinary TikZ source, received ${block.language}`,
    );
  }
  if (!tikzBlockHasContiguousSource(block)) {
    throw new Error(
      "The visual editor cannot edit this diagram while it is nested inside another Markdown block",
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

export interface TikzEditorReplacement {
  from: number;
  to: number;
  insert: string;
  next: TikzEditorSourceSession;
}

/**
 * Replace the exact CodeMirror-owned TikZ bytes with tikz-editor's source.
 * No trimming, wrapping, parsing, or normalization occurs at this boundary.
 */
export function tikzEditorReplacement(
  session: TikzEditorSourceSession,
  source: string,
): TikzEditorReplacement {
  const delta = source.length - session.source.length;
  return {
    from: session.sourceFrom,
    to: session.sourceTo,
    insert: source,
    next: {
      ...session,
      blockTo: session.blockTo + delta,
      sourceTo: session.sourceTo + delta,
      source,
    },
  };
}

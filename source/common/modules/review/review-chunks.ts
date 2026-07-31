/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        computeReviewChunks
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single review-chunk engine. A review's durable state is
 *                  two texts — the merge reference and the live document — and
 *                  a chunk is a derived view: one contiguous region where they
 *                  disagree. This module is the only place that derivation
 *                  happens. The main-process store, the HTTP API, and the
 *                  renderer's decorations all call this function, so their
 *                  partitions agree by construction; the previous architecture
 *                  ran jsdiff in main and @codemirror/merge in the renderer,
 *                  and the two disagreed on any document with repeated lines
 *                  (14 store chunks vs 3 rendered widgets on a real review).
 *
 *                  The diff kernel is @codemirror/merge's Chunk.build — the
 *                  same code that drove the old merge view, kept precisely so
 *                  chunk granularity matches what that view taught users to
 *                  expect. It is a pure function of the two texts and loads in
 *                  both the main process and the renderer.
 *
 * END HEADER
 */

import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/**
 * One contiguous disagreement between the merge reference (A side) and the
 * working document (B side).
 *
 * Offsets are character offsets into the respective text. Line numbers are
 * 1-based and half-open: the chunk covers lines [fromLine, toLine). A pure
 * insertion has an empty reference range (refFromLine === refToLine); a pure
 * deletion has an empty working range. Ranges of distinct chunks never
 * overlap.
 */
export interface ReviewChunk {
  /**
   * Content-addressed identity: a hash of the chunk's reference and working
   * text, plus an occurrence index when the same edit appears more than once
   * in one document. Accepting or rejecting one chunk therefore does NOT
   * invalidate the ids of the others — the property positional ids
   * (`chunk-<generation>-<index>`) could not provide, which is what made the
   * old chunk list unactionable: every decision renumbered the rest.
   */
  chunkId: string;
  /** Character offset range in the reference text (A side). */
  fromA: number;
  toA: number;
  /** Character offset range in the working text (B side). */
  fromB: number;
  toB: number;
  /** 1-based half-open line range in the reference text. */
  refFromLine: number;
  refToLine: number;
  /** 1-based half-open line range in the working text. */
  workFromLine: number;
  workToLine: number;
  /** The reference-side lines, newline-joined, without a trailing newline. */
  referenceText: string;
  /** The working-side lines, newline-joined, without a trailing newline. */
  workingText: string;
}

/**
 * Compute the chunk partition between a merge reference and a working text.
 * Deterministic and pure: same inputs, same chunks, same ids — in whichever
 * process it runs.
 */
export function computeReviewChunks(
  referenceText: string,
  workingText: string,
): ReviewChunk[] {
  if (referenceText === workingText) {
    return [];
  }
  const refDoc = Text.of(referenceText.split("\n"));
  const workDoc = Text.of(workingText.split("\n"));
  const chunks = Chunk.build(refDoc, workDoc);

  const result: ReviewChunk[] = [];
  const seen = new Map<string, number>();
  for (const chunk of chunks) {
    const refRange = lineRange(refDoc, chunk.fromA, chunk.toA);
    const workRange = lineRange(workDoc, chunk.fromB, chunk.toB);
    const refSlice = sliceLines(refDoc, refRange);
    const workSlice = sliceLines(workDoc, workRange);

    const hash = fnv1a64(`${refSlice}\0${workSlice}`);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);

    result.push({
      chunkId: occurrence === 0 ? `chunk-${hash}` : `chunk-${hash}-${occurrence}`,
      fromA: chunk.fromA,
      toA: chunk.toA,
      fromB: chunk.fromB,
      toB: chunk.toB,
      refFromLine: refRange.from,
      refToLine: refRange.to,
      workFromLine: workRange.from,
      workToLine: workRange.to,
      referenceText: refSlice,
      workingText: workSlice,
    });
  }
  return result;
}

/**
 * Apply a single chunk decision as a pure text operation.
 *
 * Accepting makes the reference agree with the working text on the chunk;
 * rejecting makes the working text agree with the reference. Both are the
 * same splice with the sides swapped, so both live here — the store (HTTP
 * accept/reject) and any other caller perform literally the same operation.
 */
export function spliceChunk(
  targetText: string,
  chunk: ReviewChunk,
  decision: "accept" | "reject",
): string {
  const lines = targetText.split("\n");
  const [fromLine, toLine, insert] =
    decision === "accept"
      ? [chunk.refFromLine, chunk.refToLine, chunk.workingText]
      : [chunk.workFromLine, chunk.workToLine, chunk.referenceText];
  const before = lines.slice(0, fromLine - 1);
  const after = lines.slice(toLine - 1);
  const inserted = insert === "" ? [] : insert.split("\n");
  return [...before, ...inserted, ...after].join("\n");
}

/**
 * A half-open, 1-based line interval in the merge reference. An empty
 * interval (from === to) is a boundary point: working-side lines exist
 * between reference lines from-1 and from.
 */
export interface RefSpan {
  from: number;
  to: number;
}

/**
 * Whether a chunk lies on any of the given reference spans — the single
 * overlap rule behind packet attribution. The store uses it to attribute
 * outstanding chunks to the packets whose edits produced them, and the
 * renderer uses it to pick the descriptions shown at a chunk's controls, so
 * the two surfaces agree by construction.
 *
 * Reference coordinates are the durable frame here: user edits move
 * working-side positions freely and never pass through the store, but the
 * reference moves only on decisions, which do. Non-empty intervals touch
 * openly (mere adjacency is not overlap); a boundary point touches an
 * interval when it lies on or inside its boundaries, so an insertion keeps
 * attributing to the packet that produced it while the chunk around it grows
 * or shrinks.
 */
export function chunkAttributesTo(
  chunk: Pick<ReviewChunk, "refFromLine" | "refToLine">,
  spans: readonly RefSpan[],
): boolean {
  return spans.some((span) =>
    spansTouch(span.from, span.to, chunk.refFromLine, chunk.refToLine),
  );
}

function spansTouch(
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
): boolean {
  if (aFrom === aTo) {
    return bFrom <= aFrom && aFrom <= bTo;
  }
  if (bFrom === bTo) {
    return aFrom <= bFrom && bFrom <= aTo;
  }
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Convert a chunk's character span into a 1-based half-open line range.
 *
 * Chunk.build's conventions: `from` sits at a line start; `end` sits at the
 * start of the line AFTER the chunk, and for a chunk reaching the last line
 * it points one PAST the end of the document (the position after a trailing
 * newline that is not in the text). An empty span (pure insertion/deletion
 * on this side) has from === end.
 */
function lineRange(
  doc: Text,
  from: number,
  end: number,
): { from: number; to: number } {
  // An empty span anchors at a real line start in every output Chunk.build
  // actually produces (end-of-document insertions are absorbed into the
  // preceding line), but a past-end `from` would otherwise silently splice at
  // the wrong line, so it is handled rather than assumed away.
  const fromLine = from > doc.length ? doc.lines + 1 : doc.lineAt(from).number;
  if (end <= from) {
    return { from: fromLine, to: fromLine };
  }
  const toLine = end > doc.length ? doc.lines + 1 : doc.lineAt(end).number;
  return { from: fromLine, to: toLine };
}

/** Join the lines of a 1-based half-open range without a trailing newline. */
function sliceLines(doc: Text, range: { from: number; to: number }): string {
  if (range.to <= range.from) {
    return "";
  }
  const parts: string[] = [];
  for (let n = range.from; n < range.to; n++) {
    parts.push(doc.line(n).text);
  }
  return parts.join("\n");
}

/**
 * FNV-1a, 64-bit, hex-encoded. Chosen over crypto hashes because this module
 * must load in the renderer, which has no `crypto` builtin; identity only
 * needs to distinguish chunks within one document, and the occurrence index
 * already disambiguates true duplicates.
 */
function fnv1a64(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

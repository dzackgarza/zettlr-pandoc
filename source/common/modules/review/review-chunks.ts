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
 *                  Two block-aware policies shape the raw partition, HERE, so
 *                  every consumer gets them by construction:
 *
 *                  1. Atomic blocks decide whole. A chunk starting or ending
 *                     strictly inside an atomic block ($$ display math, a
 *                     code fence, a ::: fenced div) extends to the block's
 *                     edges, and chunks inside one block merge — one
 *                     environment, one decision, controls at its edge. A
 *                     boundary is atomic if it is inside a block in EITHER
 *                     text, so a fence the edit inserts or removes still
 *                     protects the region.
 *
 *                  2. Chunks split at block seams. A chunk spanning a
 *                     paragraph seam (blank line) or a block edge splits
 *                     there, so independent paragraph-level claims of one
 *                     mega-patch become independent decisions. Seams pair
 *                     across the two texts by kind (longest common
 *                     subsequence), and no split point may fall strictly
 *                     inside an atomic block on either side.
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
  const refLines = referenceText.split("\n");
  const workLines = workingText.split("\n");
  const refDoc = Text.of(refLines);
  const workDoc = Text.of(workLines);

  let ranges: ChunkRange[] = Chunk.build(refDoc, workDoc).map((chunk) => {
    const refRange = lineRange(refDoc, chunk.fromA, chunk.toA);
    const workRange = lineRange(workDoc, chunk.fromB, chunk.toB);
    return {
      refFrom: refRange.from,
      refTo: refRange.to,
      workFrom: workRange.from,
      workTo: workRange.to,
    };
  });

  const refBlocks = atomicBlocks(refLines);
  const workBlocks = atomicBlocks(workLines);
  ranges = extendToAtomicBlocks(ranges, refBlocks, workBlocks, refLines.length);
  ranges = ranges.flatMap((range) =>
    splitAtSeams(range, refLines, workLines, refBlocks, workBlocks),
  );

  const result: ReviewChunk[] = [];
  const seen = new Map<string, number>();
  for (const range of ranges) {
    const refSlice = joinLines(refLines, range.refFrom, range.refTo);
    const workSlice = joinLines(workLines, range.workFrom, range.workTo);
    // A seam split can isolate an agreement stretch of a merged or extended
    // chunk (identical slices on both sides). It is not a disagreement, so
    // it is not a chunk.
    if (refSlice === workSlice) {
      continue;
    }

    const hash = fnv1a64(`${refSlice}\0${workSlice}`);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);

    result.push({
      chunkId: occurrence === 0 ? `chunk-${hash}` : `chunk-${hash}-${occurrence}`,
      fromA: lineStartOffset(refDoc, range.refFrom),
      toA: lineStartOffset(refDoc, range.refTo),
      fromB: lineStartOffset(workDoc, range.workFrom),
      toB: lineStartOffset(workDoc, range.workTo),
      refFromLine: range.refFrom,
      refToLine: range.refTo,
      workFromLine: range.workFrom,
      workToLine: range.workTo,
      referenceText: refSlice,
      workingText: workSlice,
    });
  }
  return result;
}

// ============================================================================
// Block-aware boundary policies
// ============================================================================

/** One chunk as bare line ranges, 1-based half-open, while policies shape it. */
interface ChunkRange {
  refFrom: number;
  refTo: number;
  workFrom: number;
  workTo: number;
}

type BlockKind = "math" | "code" | "div";

/** One atomic block: its kind and the lines it covers, fences included. */
interface AtomicBlock {
  kind: BlockKind;
  from: number;
  to: number;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * The atomic blocks of a text: $$ display math, ``` / ~~~ code fences, and
 * ::: fenced divs, as 1-based half-open line spans covering their fences. A
 * single scanner state means blocks cannot nest across kinds — a $$ inside a
 * code fence is code, a fence inside a div belongs to the div. An
 * unterminated block runs to the end of the document: exactly the
 * half-applied mega-patch case the policies exist for.
 */
function atomicBlocks(lines: readonly string[]): AtomicBlock[] {
  const blocks: AtomicBlock[] = [];
  let open:
    // `fence` is the opener's whole run: a closer must be the same character
    // and no shorter, so a ``` inside a ```` block is content, not the end.
    | { kind: "code"; from: number; fence: string }
    | { kind: "math"; from: number }
    | { kind: "div"; from: number; depth: number }
    | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;
    if (open === null) {
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence !== null) {
        open = { kind: "code", from: lineNo, fence: fence[1] };
        continue;
      }
      if (trimmed.startsWith("$$")) {
        if (trimmed.length > 2 && trimmed.endsWith("$$")) {
          // One-line $$…$$: a block of its own single line.
          blocks.push({ kind: "math", from: lineNo, to: lineNo + 1 });
        } else {
          open = { kind: "math", from: lineNo };
        }
        continue;
      }
      // A Pandoc div opens with ::: plus attributes; a bare ::: outside any
      // div is a stray closer and opens nothing.
      if (/^:{3,}/.test(trimmed) && /[^:\s]/.test(trimmed)) {
        open = { kind: "div", from: lineNo, depth: 1 };
      }
      continue;
    }
    switch (open.kind) {
      case "code": {
        const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (
          close !== null &&
          close[1][0] === open.fence[0] &&
          close[1].length >= open.fence.length
        ) {
          blocks.push({ kind: "code", from: open.from, to: lineNo + 1 });
          open = null;
        }
        break;
      }
      case "math": {
        if (trimmed.endsWith("$$")) {
          blocks.push({ kind: "math", from: open.from, to: lineNo + 1 });
          open = null;
        }
        break;
      }
      case "div": {
        if (/^:{3,}/.test(trimmed)) {
          if (/[^:\s]/.test(trimmed)) {
            open.depth += 1;
          } else if (--open.depth === 0) {
            blocks.push({ kind: "div", from: open.from, to: lineNo + 1 });
            open = null;
          }
        }
        break;
      }
    }
  }
  if (open !== null) {
    blocks.push({ kind: open.kind, from: open.from, to: lines.length + 1 });
  }
  return blocks;
}

function strictlyInside(blocks: readonly AtomicBlock[], line: number): boolean {
  return blocks.some((block) => block.from < line && line < block.to);
}

/** Lines from `line` up to the start of the block covering it; 0 outside. */
function pullToBlockStart(blocks: readonly AtomicBlock[], line: number): number {
  const block = blocks.find((b) => b.from < line && line < b.to);
  return block === undefined ? 0 : line - block.from;
}

/** Lines from `line` down to the end of the block covering it; 0 outside. */
function pushToBlockEnd(blocks: readonly AtomicBlock[], line: number): number {
  const block = blocks.find((b) => b.from < line && line < b.to);
  return block === undefined ? 0 : block.to - line;
}

/**
 * Policy 1: no chunk boundary strictly inside an atomic block of either
 * text. Boundaries extend outward to block edges, both sides in lockstep —
 * the agreement gap between chunks has the same length on both sides, so one
 * distance moves both without breaking the partition — and chunks that meet
 * inside a block merge. Extension is clamped to the gap, so a block spanning
 * several chunks merges them pairwise and the fixpoint loop then extends the
 * union; every round either merges (chunk count shrinks) or grows a range
 * (bounded by the document), so the loop terminates.
 */
function extendToAtomicBlocks(
  ranges: readonly ChunkRange[],
  refBlocks: readonly AtomicBlock[],
  workBlocks: readonly AtomicBlock[],
  refLineCount: number,
): ChunkRange[] {
  let chunks = ranges.map((range) => ({ ...range }));
  for (;;) {
    let changed = false;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const gapAbove = chunk.refFrom - (i > 0 ? chunks[i - 1].refTo : 1);
      const pull = Math.min(
        gapAbove,
        Math.max(
          pullToBlockStart(refBlocks, chunk.refFrom),
          pullToBlockStart(workBlocks, chunk.workFrom),
        ),
      );
      if (pull > 0) {
        chunk.refFrom -= pull;
        chunk.workFrom -= pull;
        changed = true;
      }
      const gapBelow =
        (i + 1 < chunks.length ? chunks[i + 1].refFrom : refLineCount + 1) -
        chunk.refTo;
      const push = Math.min(
        gapBelow,
        Math.max(
          pushToBlockEnd(refBlocks, chunk.refTo),
          pushToBlockEnd(workBlocks, chunk.workTo),
        ),
      );
      if (push > 0) {
        chunk.refTo += push;
        chunk.workTo += push;
        changed = true;
      }
    }
    const merged: ChunkRange[] = [];
    for (const chunk of chunks) {
      const last = merged[merged.length - 1];
      if (
        last !== undefined &&
        chunk.refFrom === last.refTo &&
        (strictlyInside(refBlocks, chunk.refFrom) ||
          strictlyInside(workBlocks, chunk.workFrom))
      ) {
        last.refTo = chunk.refTo;
        last.workTo = chunk.workTo;
        changed = true;
        continue;
      }
      merged.push(chunk);
    }
    chunks = merged;
    if (!changed) {
      return chunks;
    }
  }
}

/**
 * A candidate split point and what makes it one, so pairing can refuse to
 * match a paragraph seam in one text against a fence edge in the other.
 */
interface Seam {
  line: number;
  kind: string;
}

/**
 * The split candidates strictly inside one side of a chunk: the start of
 * every blank-line run (a paragraph seam) and every atomic-block edge, none
 * of them inside an atomic block on this side.
 */
function seamCandidates(
  lines: readonly string[],
  blocks: readonly AtomicBlock[],
  from: number,
  to: number,
): Seam[] {
  const seams: Seam[] = [];
  for (let line = from + 1; line < to; line++) {
    if (strictlyInside(blocks, line)) {
      continue;
    }
    const opening = blocks.find((block) => block.from === line);
    if (opening !== undefined) {
      seams.push({ line, kind: `${opening.kind}-open` });
      continue;
    }
    const closing = blocks.find((block) => block.to === line);
    if (closing !== undefined) {
      seams.push({ line, kind: `${closing.kind}-close` });
      continue;
    }
    if (isBlank(lines[line - 1]) && !isBlank(lines[line - 2])) {
      seams.push({ line, kind: "blank" });
    }
  }
  return seams;
}

/**
 * The longest order-preserving matching of two seam lists agreeing on kind —
 * plain LCS. Pairing by kind is what keeps a moved blank line pairing with a
 * blank line rather than with a fence edge.
 *
 * ponytail: structural pairing, no content similarity — when an edit adds a
 * whole new environment mid-chunk, an unpaired seam simply does not split,
 * which is the safe floor.
 */
function pairSeams(
  refSeams: readonly Seam[],
  workSeams: readonly Seam[],
): Array<[number, number]> {
  const dp: number[][] = Array.from({ length: refSeams.length + 1 }, () =>
    new Array<number>(workSeams.length + 1).fill(0),
  );
  for (let i = refSeams.length - 1; i >= 0; i--) {
    for (let j = workSeams.length - 1; j >= 0; j--) {
      dp[i][j] =
        refSeams[i].kind === workSeams[j].kind
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < refSeams.length && j < workSeams.length) {
    if (
      refSeams[i].kind === workSeams[j].kind &&
      dp[i][j] === dp[i + 1][j + 1] + 1
    ) {
      pairs.push([refSeams[i].line, workSeams[j].line]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Policy 2: split one chunk at its paired seams. Any consistent split of
 * both sides preserves convergence — the sub-ranges partition the chunk on
 * both sides — and a side with no interior (a pure insertion or deletion)
 * has no candidates, so such chunks never split.
 */
function splitAtSeams(
  range: ChunkRange,
  refLines: readonly string[],
  workLines: readonly string[],
  refBlocks: readonly AtomicBlock[],
  workBlocks: readonly AtomicBlock[],
): ChunkRange[] {
  const pairs = pairSeams(
    seamCandidates(refLines, refBlocks, range.refFrom, range.refTo),
    seamCandidates(workLines, workBlocks, range.workFrom, range.workTo),
  );
  if (pairs.length === 0) {
    return [range];
  }
  const out: ChunkRange[] = [];
  let refFrom = range.refFrom;
  let workFrom = range.workFrom;
  for (const [refLine, workLine] of pairs) {
    out.push({ refFrom, refTo: refLine, workFrom, workTo: workLine });
    refFrom = refLine;
    workFrom = workLine;
  }
  out.push({ refFrom, refTo: range.refTo, workFrom, workTo: range.workTo });
  return out;
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
function joinLines(lines: readonly string[], from: number, to: number): string {
  if (to <= from) {
    return "";
  }
  return lines.slice(from - 1, to - 1).join("\n");
}

/**
 * The character offset of a 1-based line's start; the document length for
 * the boundary one past the last line (an insertion point at the end).
 */
function lineStartOffset(doc: Text, line: number): number {
  return line > doc.lines ? doc.length : doc.line(line).from;
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

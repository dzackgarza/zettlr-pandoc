
/**
 * What a renderer pane needs to DISPLAY a review: the provider-owned merge
 * reference and the identifiers to send decisions back with. The pane derives
 * its widgets from (referenceText, its own live document) via the shared chunk
 * engine and never reports state — decisions go through the provider's
 * decide-review-chunk command, and the next broadcast of this session is the
 * only way review state changes reach the pane.
 */
export interface ReviewDiffSession {
  id: string;
  reviewGeneration: number;
  documentPath: string;
  /**
   * The provider-owned merge reference. Accepting a chunk moves this text
   * toward the editable document; rejecting moves the editable document
   * toward this text. Only the provider mutates either.
   */
  referenceText: string;
  /** The provider-authoritative working bytes the pane currently displays. */
  workingText: string;
  /**
   * Every packet's attribution surface, in application order. The pane
   * matches its chunks against the spans (shared chunkAttributesTo rule) to
   * pick the descriptions shown at each chunk's controls.
   */
  packets: ReviewPacketAttribution[];
  /**
   * The chunk-anchored comments, by content-addressed id. The pane renders
   * each at its chunk's controls strip; an id that no longer matches any
   * chunk simply stops matching (the provider orphans the note on its side —
   * the pane never reports state back).
   */
  chunkComments: ReviewChunkCommentView[];
}

/** One chunk-anchored comment as a pane sees it: identity plus the text. */
export interface ReviewChunkCommentView {
  chunkId: string;
  comment: string;
  referenceText?: string;
  workingText?: string;
  referenceFromLine?: number;
  workingFromLine?: number;
}

/**
 * One packet's attribution: identity, the claim's prose, and its current
 * reference-side edit spans (half-open, 1-based line intervals in the merge
 * reference, empty interval = insertion boundary). The provider records the
 * spans at packet application and remaps them across decisions; the pane
 * only reads them.
 */
export interface ReviewPacketAttribution {
  packetId: string;
  description?: string;
  refSpans: Array<{ from: number, to: number }>;
}

export interface ReviewDiffDocumentSnapshot {
  path: string;
  content: string;
  documentVersion: number;
  contentSha256: string;
  dirty: boolean;
}

export interface ReviewDiffOpenRequest {
  path: string;
  baselineVersion: number;
  baselineSha256: string;
  patchPath?: string;
  patchText?: string;
  proposedText?: string;
  description?: string;
}

export type ReviewDiffOpenResult =
  | { accepted: true; sessionId: string }
  | {
    accepted: false;
    reason: 'stale-baseline' | 'invalid-request' | 'open-failed';
    message: string;
  }

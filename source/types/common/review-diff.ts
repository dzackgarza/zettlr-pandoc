/**
 * What a renderer pane needs to display a review: stable suggestions and the
 * identifiers to send decisions back with. The
 * pane renders their mapped anchors over its live document and never reports
 * state — decisions go through the provider's
 * decide-review-chunk command, and the next broadcast of this session is the
 * only way review state changes reach the pane.
 */
export interface ReviewDiffSession {
  id: string;
  reviewGeneration: number;
  documentPath: string;
  /** The provider-authoritative working bytes the pane currently displays. */
  workingText: string;
  suggestions: ReviewSuggestionView[];
  /**
   * The chunk-anchored comments, by stable suggestion id. The pane renders
   * each at its suggestion's controls strip. The pane never reports state
   * back.
   */
  chunkComments: ReviewChunkCommentView[];
}

/** One chunk-anchored comment as a pane sees it: identity plus the text. */
export interface ReviewChunkCommentView {
  chunkId: string;
  comment: string;
}

export interface ReviewSuggestionView {
  suggestionId: string;
  removedText: string;
  anchors: Array<{ from: number; to: number }>;
  seam: number;
  description: string;
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
      reason: "stale-baseline" | "invalid-request" | "open-failed";
      message: string;
    };

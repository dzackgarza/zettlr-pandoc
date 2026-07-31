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
  description?: string;
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

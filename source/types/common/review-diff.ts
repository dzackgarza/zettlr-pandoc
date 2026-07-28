export interface ReviewDiffSession {
  id: string;
  reviewGeneration: number;
  documentPath: string;
  patchPath?: string;
  /**
   * SHA-256 of the live document content the proposition was built against.
   * This also powers idempotent proposal application and replays.
   */
  baselineSha256: string;
  /**
   * SHA-256 of the on-disk document when the review opened. The final save gate
   * uses this to preserve external disk edits.
   */
  diskBaselineSha256: string;
  baselineText: string;
  /**
   * CodeMirror's mutable unified-merge reference document. Accepting a chunk
   * moves this text toward the editable document; rejecting moves the editable
   * document toward this text.
   */
  originalText: string;
  proposedText: string;
  /**
   * The authoritative provider buffer this session should currently display.
   */
  currentText: string;
  description?: string;
}

export interface ReviewDiffStatus {
  filePath: string;
  sessionId: string;
  unresolvedChunks: number;
  originalText: string;
  currentText: string;
  documentVersion: number;
  sourceWindowId: string;
  sourceLeafId: string;
  /** Spec section 13: the review generation the pane observed when reporting. */
  reviewGeneration?: number;
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

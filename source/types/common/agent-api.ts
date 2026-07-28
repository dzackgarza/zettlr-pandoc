/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent API protocol types
 * CVM-Role:         Types
 * Maintainer:       D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     OpenAPI/HTTP protocol types for the Zettlr-Pandoc agent
 *                  API. These types are shared between the Electron main
 *                  process service provider and external clients that consume
 *                  the OpenAPI contract.
 *
 * END HEADER
 */

// ============================================================================
// Section 4: Core identifiers and revisions
// ============================================================================

export interface DocumentRevision {
  version: number;
  sha256: string;
}

export interface ReviewRevision {
  generation: number;
}

export interface EditorViewSummary {
  viewId: string;
  windowId: string;
  leafId: string;
  focused: boolean;
  active: boolean;
}

export type ReviewState =
  | "active"
  | "resolved-awaiting-save"
  | "completed"
  | "cleared"
  | "invalidated";

export interface ReviewSummary {
  reviewId: string;
  state: ReviewState;
  generation: number;
  unresolvedChunks: number;
  packetCount: number;
}

export type DocumentType = "markdown" | "code";

export interface DocumentSummary {
  documentId: string;
  uri: string;
  path: string;
  name: string;
  type: DocumentType;
  dirty: boolean;
  revision: DocumentRevision;
  lineCount: number;
  byteLength: number;
  views: EditorViewSummary[];
  review?: ReviewSummary;
}

// ============================================================================
// Section 4: Snapshot tokens
// ============================================================================

/**
 * A snapshot token binds a read to a specific documentId + version + content
 * hash. The snapshot, rather than the current focus, identifies the target
 * during proposal submission. Changing tabs between reading and proposing
 * cannot redirect a patch to the wrong document.
 *
 * Format: snap_v1_<base64url(documentId|version|sha256)>
 */
export interface SnapshotToken {
  /** The literal token string returned by a read operation. */
  token: string;
  /** The documentId the snapshot is bound to. */
  documentId: string;
  /** The document version at read time. */
  version: number;
  /** The SHA-256 hex digest of the document content at read time. */
  sha256: string;
}

// ============================================================================
// Section 4: Focused context
// ============================================================================

export interface FocusedViewSummary {
  viewId: string;
  windowId: string;
  leafId: string;
  documentId: string;
}

export interface EditorContext {
  focusedView?: FocusedViewSummary;
  focusedDocument?: DocumentSummary;
  openDocuments: DocumentSummary[];
}

// ============================================================================
// Section 5.3: Document read responses
// ============================================================================

export type ReadSide = "working" | "reference";

export interface ReadRange {
  startLine: number;
  endLine: number;
  totalLines: number;
}

export interface ReadDocumentResponse {
  documentId: string;
  side: ReadSide;
  snapshot?: string;
  revision: DocumentRevision;
  reviewGeneration?: number;
  range: ReadRange;
  content: string;
  truncated: boolean;
}

export interface SearchHit {
  line: number;
  column: number;
  length: number;
  contextBefore: string;
  contextAfter: string;
}

export interface SearchResponse {
  documentId: string;
  snapshot: string;
  revision: DocumentRevision;
  hits: SearchHit[];
  truncated: boolean;
}

// ============================================================================
// Section 6: Proposal submission
// ============================================================================

export type PatchFormat = "unified-diff";

export interface SubmitProposalRequest {
  snapshot: string;
  patchFormat: PatchFormat;
  patch: string;
  description?: string;
  /**
   * If set, the request is refused when the current review generation does
   * not match. Guards against applying a packet built against a stale
   * review state.
   */
  expectedReviewGeneration?: number;
}

export interface SubmitProposalResponse {
  packetId: string;
  reviewId: string;
  documentId: string;
  documentRevision: DocumentRevision;
  reviewGeneration: number;
  unresolvedChunks: number;
  state: ReviewState;
}

// ============================================================================
// Section 7: Active review state and packets
// ============================================================================

export interface ProposalPacket {
  packetId: string;
  reviewId: string;
  clientRequestId: string;
  description?: string;
  appliedAt: string; // ISO 8601 timestamp
  patchFormat: PatchFormat;
  patch: string;
  applicationGeneration: number;
}

export interface ActiveReviewState {
  reviewId: string;
  documentId: string;
  /** Stored for patch header validation in submitPacket. */
  documentPath: string;
  /** The initial baseline text when the review opened. Does not change. */
  baselineText: string;
  /** Evolving merge reference: accepted state + rejected restorations. */
  referenceText: string;
  /** Current visible provider document. */
  workingText: string;
  generation: number;
  packets: ProposalPacket[];
  diskFenceSha256: string;
  /** True after external disk drift invalidated the review (spec section 10). */
  invalidated: boolean;
}

// ============================================================================
// Section 8: Review inspection
// ============================================================================

export interface OutstandingChunk {
  chunkId: string;
  generation: number;
  referenceRange: {
    fromLine: number;
    toLine: number;
  };
  workingRange: {
    fromLine: number;
    toLine: number;
  };
  patch: string;
}

export interface ReviewDiffResponse {
  reviewId: string;
  documentId: string;
  patch: string;
  generation: number;
}

export interface ReviewChunksResponse {
  reviewId: string;
  documentId: string;
  generation: number;
  chunks: OutstandingChunk[];
}

export interface ReviewPacketsResponse {
  reviewId: string;
  documentId: string;
  packets: ProposalPacket[];
}

export interface ReviewStatusResponse {
  reviewId: string;
  documentId: string;
  state: ReviewState;
  generation: number;
  unresolvedChunks: number;
  packetCount: number;
  documentRevision: DocumentRevision;
}

export interface ReviewListResponse {
  reviews: ReviewSummary[];
}

// ============================================================================
// Section 9: Retraction and clearing
// ============================================================================

export interface RetractProposalRequest {
  packetId: string;
}

export type RetractProposalResponse =
  | {
      retracted: true;
      packetId: string;
      reviewId: string;
      documentId: string;
      documentRevision: DocumentRevision;
      reviewGeneration: number;
      unresolvedChunks: number;
    }
  | {
      retracted: false;
      code: "PACKET_NOT_RETRACTABLE";
      message: string;
      reviewId: string;
      canClearUnresolved: true;
    };

export interface ClearReviewRequest {
  reviewId: string;
  discardUnresolved: true;
}

export interface ClearReviewResponse {
  reviewId: string;
  documentId: string;
  state: ReviewState;
  documentRevision: DocumentRevision;
}

// ============================================================================
// Section 5.1: Capabilities
// ============================================================================

export interface CapabilitiesResponse {
  protocolVersion: string;
  supportedPatchFormats: PatchFormat[];
  reviewSupport: true;
  retractionSupport: true;
  maxRequestSize: number;
  eventStreamSupport: true;
  eventReplayBufferSize: number;
  applicationVersion: string;
  instanceId: string;
}

export interface PingResponse {
  protocolVersion: string;
  instanceId: string;
  pid: number;
}

// ============================================================================
// Section 11: Events
// ============================================================================

export type AgentEventType =
  | "focus.changed"
  | "document.changed"
  | "document.closed"
  | "review.started"
  | "proposal.applied"
  | "proposal.retracted"
  | "review.changed"
  | "review.resolved"
  | "review.completed"
  | "review.cleared"
  | "review.invalidated"
  | "app.shutting-down";

export interface AgentEvent {
  event: AgentEventType;
  timestamp: string;
  id?: string;
  reviewId?: string;
  documentId?: string;
  documentRevision?: DocumentRevision;
  reviewGeneration?: number;
  unresolvedChunks?: number;
}

// ============================================================================
// Section 12: Error codes
// ============================================================================

export type AgentErrorCode =
  | "APP_NOT_RUNNING"
  | "PROTOCOL_MISMATCH"
  | "NO_FOCUSED_DOCUMENT"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_CLOSED"
  | "REVISION_MISMATCH"
  | "REVIEW_GENERATION_MISMATCH"
  | "REVIEW_NOT_FOUND"
  | "REVIEW_INVALIDATED"
  | "PATCH_INVALID"
  | "PATCH_NOT_APPLICABLE"
  | "PACKET_NOT_RETRACTABLE"
  | "REQUEST_TOO_LARGE"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "INTERNAL_ERROR";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  documentId?: string;
  expected?: DocumentRevision;
  actual?: DocumentRevision;
  reviewId?: string;
  canClearUnresolved?: boolean;
}

export const AGENT_API_PROTOCOL_VERSION = "1.0";

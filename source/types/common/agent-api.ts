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

/**
 * The body of POST /v1/documents/{documentId}/proposals. Everything the
 * operation needs is in the body; it reads no request headers.
 *
 * This used to require `If-Match` and `Idempotency-Key` as headers. Both moved
 * here because a schema-driven client cannot send them — an OpenAPI consumer
 * generating calls from this document (a Custom GPT Action, for one) drops
 * header parameters and would be refused on every attempt. `If-Match` was
 * redundant besides: it asserted the current content hash, which `snapshot`
 * already pins along with the version, so it could only fail where the
 * snapshot check failed anyway.
 *
 * The patch's `---`/`+++` headers must name the target document, either as the
 * literal `document` or as its absolute path (with or without a git-style
 * `a/`/`b/` prefix). Any other filename is rejected as PATCH_INVALID.
 */
export interface SubmitProposalRequest {
  snapshot: string;
  patchFormat: PatchFormat;
  patch: string;
  description?: string;
  /**
   * Client-chosen unique string. Replaying the same value returns the original
   * packet instead of applying the patch twice; reusing it for a different
   * request is refused as IDEMPOTENCY_CONFLICT.
   */
  clientRequestId: string;
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
  /**
   * Evolving merge reference: accepted state + rejected restorations. This is
   * the ONLY text a review stores. The working text is the live document,
   * owned by the document authority and read through the store's resolver —
   * a mirrored copy here is what previously let the two drift apart.
   */
  referenceText: string;
  generation: number;
  packets: ProposalPacket[];
  diskFenceSha256: string;
  /** True after external disk drift invalidated the review. */
  invalidated: boolean;
}

// ============================================================================
// Section 8: Review inspection
// ============================================================================

export interface OutstandingChunk {
  /**
   * Content-addressed identity, stable while the chunk's own text is
   * untouched: deciding one chunk does not invalidate the ids of the others.
   * A decision on a chunk whose region has since changed fails with
   * CHUNK_NOT_FOUND instead of applying somewhere unintended.
   */
  chunkId: string;
  /** 1-based, half-open: the chunk covers lines [fromLine, toLine). An empty
   * range (fromLine === toLine) marks a pure insertion or deletion side. */
  referenceRange: {
    fromLine: number;
    toLine: number;
  };
  workingRange: {
    fromLine: number;
    toLine: number;
  };
  /** The reference-side lines, newline-joined; "" for a pure insertion. */
  referenceText: string;
  /** The working-side lines, newline-joined; "" for a pure deletion. */
  workingText: string;
  /** Focused zero-context unified diff of exactly this chunk. */
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

/**
 * A single entry of GET /v1/views. Distinct from EditorViewSummary, which is
 * the per-document projection embedded in DocumentSummary.views.
 */
export interface ViewSummary {
  viewId: string;
  windowId: string;
  leafId: string;
  documentId?: string;
  focused: boolean;
  active: boolean;
  documents: Array<{ documentId?: string; path: string }>;
}

/**
 * The body of the long-poll GET /v1/reviews/{reviewId}/events. `status` is a
 * ReviewSummary, not a ReviewStatusResponse: the long-poll reports the review's
 * own state and carries no documentId/documentRevision.
 */
export interface ReviewEventsResponse {
  reviewId: string;
  status?: ReviewSummary;
  /** Present when a status change woke the poll. */
  events?: AgentEvent[];
  /** True if the request reached its timeout before a status change. */
  timedOut?: boolean;
}

// ============================================================================
// Request bodies (validated once at the HTTP boundary)
// ============================================================================

export interface OpenDocumentRequest {
  uri: string;
}

export interface SearchDocumentRequest {
  literal: string;
  context?: number;
}

// ============================================================================
// System and listing responses
// ============================================================================

export interface DocumentListResponse {
  documents: DocumentSummary[];
}

export interface ViewListResponse {
  views: ViewSummary[];
}

export interface WorkspaceSummary {
  workspaceId: string;
  path: string;
}

export interface WorkspacesResponse {
  workspaces: WorkspaceSummary[];
}

/**
 * A workspace listing entry: a loaded document's full summary, or — for a file
 * the provider has not opened yet — its identity fields alone.
 */
export type WorkspaceDocumentEntry =
  | (DocumentSummary & { workspaceId: string; loaded: true })
  | {
      documentId: string;
      uri: string;
      path: string;
      name: string;
      workspaceId: string;
      loaded: false;
    };

export interface WorkspaceDocumentsResponse {
  workspaceId: string;
  documents: WorkspaceDocumentEntry[];
}

export interface FocusDocumentResponse {
  focused: true;
  documentId: string;
}

export interface ClearReviewResponse {
  reviewId: string;
  documentId: string;
  state: ReviewState;
  documentRevision: DocumentRevision;
}

// ============================================================================
// Section 12: Error codes
// ============================================================================

/**
 * Every error code the server may emit, as a runtime value.
 *
 * This is the single source of truth: `AgentErrorCode` is derived from it, and
 * a conformance test asserts openapi.yaml's `AgentError.code` enum lists exactly
 * these. Publishing the enum by hand let it drift — it omitted INTERNAL_ERROR
 * while the server emitted that code from four separate 500 paths, so those
 * responses contradicted the spec agents validate against.
 */
export const AGENT_ERROR_CODES = [
  "APP_NOT_RUNNING",
  "PROTOCOL_MISMATCH",
  "NO_FOCUSED_DOCUMENT",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_CLOSED",
  "REVISION_MISMATCH",
  "REVIEW_GENERATION_MISMATCH",
  "REVIEW_NOT_FOUND",
  "REVIEW_INVALIDATED",
  "PATCH_INVALID",
  "PATCH_NOT_APPLICABLE",
  "PACKET_NOT_RETRACTABLE",
  "CHUNK_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_TOO_LARGE",
  "REQUEST_BODY_TIMEOUT",
  "METHOD_NOT_FOUND",
  "INVALID_PARAMS",
  "UNAUTHORIZED",
  "INTERNAL_ERROR",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  documentId?: string;
  expected?: DocumentRevision;
  actual?: DocumentRevision;
  reviewId?: string;
  canClearUnresolved?: boolean;
}

export interface AgentErrorResponse {
  error: AgentError;
}

/**
 * Every body the HTTP server may serialize. Typing the send sink against this
 * union is what makes an undeclared response shape a compile error rather than
 * a surprise for a client written from the OpenAPI contract.
 */
export type AgentApiResponseBody =
  | PingResponse
  | CapabilitiesResponse
  | EditorContext
  | DocumentSummary
  | DocumentListResponse
  | ViewListResponse
  | WorkspacesResponse
  | WorkspaceDocumentsResponse
  | FocusDocumentResponse
  | ReadDocumentResponse
  | SearchResponse
  | SubmitProposalResponse
  | ReviewListResponse
  | ReviewStatusResponse
  | ReviewDiffResponse
  | ReviewChunksResponse
  | ReviewPacketsResponse
  | ReviewEventsResponse
  | ClearReviewResponse
  | RetractProposalResponse
  | AgentErrorResponse;

export const AGENT_API_PROTOCOL_VERSION = "1.0";

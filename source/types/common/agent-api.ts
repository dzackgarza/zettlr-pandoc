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

/**
 * A hold: a comment attached to a chunk WITHOUT adjudicating it (the comment
 * is optional — a hold without text is legal). Held chunks are excluded from
 * the save-gate count and survive a save; the reference simply retains its
 * disagreement over that span. Holds are keyed by content-addressed chunkId,
 * so an edit inside a held chunk orphans the hold: its comment surfaces as a
 * review-level ReviewComment carrying orphanedFromChunkId.
 */
export interface ChunkHold {
  chunkId: string;
  comment?: string;
  heldAt: string; // ISO 8601 timestamp
  /** Snapshot used to reattach the hold when unrelated lines shift. */
  referenceText?: string;
  workingText?: string;
  referenceFromLine?: number;
  workingFromLine?: number;
}

/** A review-level comment — attached directly, or salvaged from a hold. */
export interface ReviewComment {
  text: string;
  createdAt: string; // ISO 8601 timestamp
  /**
   * Present when this comment was carried over from a hold whose chunk id
   * vanished from the partition (the chunk was edited, decided, cleared, or
   * absorbed by a later claim). The hold's text is never silently lost.
   */
  orphanedFromChunkId?: string;
}

export interface ReviewSummary {
  reviewId: string;
  state: ReviewState;
  generation: number;
  unresolvedChunks: number;
  heldChunks: number;
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

export interface SearchDocumentResponse {
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
 * One claim of a proposal batch: a prose description of what the edit
 * accomplishes, and the patch implementing exactly that. No basis enum, no
 * intent field, no dependency schema — the description is prose.
 */
export interface ProposalClaim {
  description: string;
  patch: string;
}

/**
 * The body of POST /v1/documents/{documentId}/proposals. Everything the
 * operation needs is in the body; it reads no request headers.
 *
 * A proposal is either a single `patch` (with an optional `description`) or
 * an ordered `claims` sequence — exactly one of the two shapes. Claims apply
 * against the ONE snapshot, sequentially and atomically: claim k applies with
 * zero fuzz to the text claim k-1 produced, all-or-nothing, and each claim
 * becomes its own packet. The single-patch shape is the one-claim degenerate
 * case.
 *
 * This used to require `If-Match` and `Idempotency-Key` as headers. Both moved
 * here because a schema-driven client cannot send them — an OpenAPI consumer
 * generating calls from this document (a Custom GPT Action, for one) drops
 * header parameters and would be refused on every attempt. `If-Match` was
 * redundant besides: it asserted the current content hash, which `snapshot`
 * already pins along with the version, so it could only fail where the
 * snapshot check failed anyway.
 *
 * Every patch's `---`/`+++` headers must name the target document, either as
 * the literal `document` or as its absolute path (with or without a git-style
 * `a/`/`b/` prefix). Any other filename is rejected as PATCH_INVALID.
 */
export interface SubmitProposalRequest {
  snapshot: string;
  patchFormat: PatchFormat;
  patch?: string;
  description?: string;
  claims?: ProposalClaim[];
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
  /** The newest packet of this submission — the last element of packetIds. */
  packetId: string;
  /** One packet per claim, in claim order; a single patch has exactly one. */
  packetIds: string[];
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
  /**
   * Chunk holds, reconciled lazily against the live partition: a hold whose
   * chunk id no longer exists is removed, and its comment (if any) moves to
   * `comments` as an orphan.
   */
  holds: ChunkHold[];
  /** Review-level comments, in creation order. */
  comments: ReviewComment[];
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
  /**
   * The packets whose edits produced this chunk, in application order:
   * every packet whose recorded reference-side edit spans still touch the
   * chunk's reference range. Overlapping claims attribute together, and a
   * chunk the user tweaked keeps the attribution of the claim it grew from —
   * the reference frame moves only on decisions, never on user edits. Empty
   * for a chunk only the user's own edits created.
   */
  packetIds: string[];
  /**
   * Those packets' descriptions, in the same order, packets without one
   * omitted.
   */
  descriptions: string[];
  /**
   * The chunk's decision state. Only undecided chunks exist in the partition
   * — an accepted or rejected chunk stops being a disagreement and vanishes —
   * so the wire carries exactly `pending` and `held`.
   */
  state: "pending" | "held";
  /** The hold's comment, when this chunk is held with one. */
  holdComment?: string;
  /** Focused zero-context unified diff of exactly this chunk. */
  patch: string;
}

export interface ReviewDiffResponse {
  reviewId: string;
  /** Absent for a detached review: no document is open to carry an id. */
  documentId?: string;
  patch: string;
  generation: number;
}

export interface ReviewChunksResponse {
  reviewId: string;
  /** Absent for a detached review: no document is open to carry an id. */
  documentId?: string;
  generation: number;
  chunks: OutstandingChunk[];
}

export interface ReviewPacketsResponse {
  reviewId: string;
  /** Absent for a detached review: no document is open to carry an id. */
  documentId?: string;
  packets: ProposalPacket[];
}

/**
 * The body of GET /v1/reviews/{reviewId}: the review's own status, its
 * comments, and — while the reviewed file is open — the live document
 * revision. The wire carries no documentId here: the review is addressed by
 * reviewId, and /v1/reviews is the surface that maps reviews to documents.
 *
 * Every reviewId /v1/reviews hands out answers here, detached ones included:
 * a detached review is served from its sidecar, which carries the whole
 * review. Deciding its chunks still needs the file open — those routes
 * answer DOCUMENT_CLOSED naming the path — but reading it does not.
 */
export interface ReviewDetailResponse {
  reviewId: string;
  state: ReviewState;
  generation: number;
  unresolvedChunks: number;
  heldChunks: number;
  packetCount: number;
  /** Review-level comments, direct and orphaned-from-hold alike. */
  comments: ReviewComment[];
  /** True while the reviewed document is open; see ReviewListEntry.attached. */
  attached: boolean;
  /**
   * The open document's revision. Absent when the review is detached —
   * there is no open document, and a fabricated revision would describe a
   * state nobody has.
   */
  documentRevision?: DocumentRevision;
}

/** One entry of GET /v1/reviews: a ReviewSummary plus the document it reviews. */
export interface ReviewListEntry extends ReviewSummary {
  /**
   * Present for a review attached to an open document. A detached
   * (sidecar-backed) review has no live documentId — it is addressed by
   * documentPath, and reattaches by opening that file.
   */
  documentId?: string;
  /** The absolute path of the reviewed file. */
  documentPath: string;
  /**
   * True while the reviewed document is open; false for a review persisted
   * in its sidecar after the file closed. There is no reattach API —
   * opening the file is the reattachment.
   */
  attached: boolean;
}

export interface ReviewListResponse {
  reviews: ReviewListEntry[];
}

/** The three decision verbs a chunk accepts. Hold annotates without adjudicating. */
export type ChunkDecision = "accept" | "reject" | "hold";

/**
 * The body of POST /v1/reviews/{reviewId}/chunks/{chunkId}/accept | /reject
 * | /hold. The same shape DocumentManager.decideChunk returns on success —
 * the HTTP layer serializes it unchanged.
 */
export interface ChunkDecisionResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  chunkId: string;
  decision: ChunkDecision;
  reviewGeneration: number;
  unresolvedChunks: number;
  state: ReviewState;
  documentRevision: DocumentRevision;
}

/**
 * The 200 body of POST /v1/reviews/{reviewId}/accept-all: every chunk of the
 * current partition accepted in one sweep — the mirror of clear, which is
 * mass reject. The document does not change; the reference now agrees with
 * it. Held chunks are accepted too, their comments preserved as orphaned
 * review-level comments.
 */
export interface AcceptAllChunksResponse {
  ok: true;
  reviewId: string;
  documentId: string;
  /** How many chunks the sweep resolved (held ones included). */
  acceptedChunks: number;
  reviewGeneration: number;
  unresolvedChunks: number;
  state: ReviewState;
  documentRevision: DocumentRevision;
}

/**
 * The body of POST /v1/reviews/{reviewId}/chunks/{chunkId}/hold. The whole
 * body is optional — a hold without text is legal. Re-holding a held chunk
 * replaces its comment.
 */
export interface HoldChunkRequest {
  comment?: string;
}

/** The body of POST /v1/reviews/{reviewId}/comments. */
export interface AddReviewCommentRequest {
  text: string;
}

/** The 200 body of POST /v1/reviews/{reviewId}/comments. */
export interface ReviewCommentResponse {
  reviewId: string;
  documentId: string;
  reviewGeneration: number;
  comment: ReviewComment;
}

// ============================================================================
// Section 9: Retraction and clearing
// ============================================================================

export interface RetractProposalRequest {
  packetId: string;
}

/**
 * The 200 body of POST /v1/proposals/{packetId}/retract. A refused retraction
 * is not this shape: it is a 409 AgentErrorResponse whose error carries
 * PACKET_NOT_RETRACTABLE plus the reviewId and canClearUnresolved details.
 */
export interface RetractProposalResponse {
  retracted: true;
  packetId: string;
  reviewId: string;
  documentId: string;
  documentRevision: DocumentRevision;
  reviewGeneration: number;
  unresolvedChunks: number;
}

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
  | "review.discarded"
  | "review.invalidated"
  | "review.held"
  | "review.commented"
  | "review.sidecar-error"
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
  /** review.held: the chunk that was held. */
  chunkId?: string;
  /** review.held / review.commented: the comment text, when one exists. */
  comment?: string;
  /** review.commented: set when the comment was salvaged from a dangling hold. */
  orphanedFromChunkId?: string;
  /** review.sidecar-error: what failed and why. */
  message?: string;
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

export interface ViewsResponse {
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

/** One file of GET /v1/workspace/files: identity plus whether it is loaded. */
export interface WorkspaceFileEntry {
  documentId: string;
  path: string;
  name: string;
  workspaceId: string;
  /** Whether the file is currently loaded in the editor. */
  open: boolean;
}

/**
 * The body of GET /v1/workspace/files: every file across the configured
 * workspaces, flat — the agent's orientation entry point.
 */
export interface WorkspaceFilesResponse {
  files: WorkspaceFileEntry[];
}

export interface FocusDocumentResponse {
  focused: true;
  documentId: string;
}

/**
 * Result of releasing a clean document that has no editor view. The review
 * CLI uses this only to undo a pre-submission load after a refusal; a false
 * result is deliberately non-destructive when another owner appeared.
 */
export interface ReleaseDocumentResponse {
  released: boolean;
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
  "SEARCH_TIMEOUT",
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
  | ViewsResponse
  | WorkspacesResponse
  | WorkspaceDocumentsResponse
  | WorkspaceFilesResponse
  | FocusDocumentResponse
  | ReleaseDocumentResponse
  | ReadDocumentResponse
  | SearchDocumentResponse
  | SubmitProposalResponse
  | ReviewListResponse
  | ReviewDetailResponse
  | ReviewDiffResponse
  | ReviewChunksResponse
  | ChunkDecisionResponse
  | AcceptAllChunksResponse
  | ReviewCommentResponse
  | ReviewPacketsResponse
  | ReviewEventsResponse
  | ClearReviewResponse
  | RetractProposalResponse
  | AgentErrorResponse;

export { AGENT_API_PROTOCOL_VERSION } from "./agent-api-version.cjs";

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Collaboration sidecar schema (version 5)
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one description of what a persisted collaboration
 *                  sidecar looks like. Declared once with TypeBox, so the
 *                  runtime validator and the TypeScript type are the same
 *                  statement.
 *
 *                  Version 4 held one review, flat. Version 5 holds a
 *                  document's whole collaboration state: a nullable review
 *                  (annotations outlive review sessions and must persist
 *                  with none active) alongside durable text annotations, the
 *                  disk fence, and the pending-save marker — all fields a
 *                  save or an annotation mutation needs regardless of
 *                  whether a review is open.
 *
 *                  `annotations.items` reuses TextAnnotation from
 *                  annotation-domain.ts rather than redeclaring its shape:
 *                  Type.Unsafe pins the runtime schema to that exact type,
 *                  so the two cannot drift the way a hand-copied interface
 *                  would.
 *
 *                  Every object refuses unknown fields, and only version 4
 *                  and version 5 are recognized: version 4 is deterministically
 *                  lifted to version 5 on read (see migrateV4ToV5Sidecar), and
 *                  everything older is a bug to be seen loudly, not a shape
 *                  to be migrated.
 *
 * END HEADER
 */

import { Type, type Static } from "@sinclair/typebox";
import type {
  AnnotationAnchor,
  AnnotationMessage,
  AnnotationProposalAction,
  TextAnnotation,
} from "@dts/common/annotation-domain";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });

const PendingSaveSchema = Type.Object(
  {
    beforeDiskSha256: Sha256,
    afterDiskSha256: Sha256,
  },
  { additionalProperties: false },
);

// ============================================================================
// Review state (nested under `review`, present only while a review is open)
// ============================================================================

const ReviewPacketSchema = Type.Object(
  {
    packetId: Type.String(),
    reviewId: Type.String(),
    clientRequestId: Type.String(),
    requestFingerprint: Sha256,
    description: Type.String(),
    appliedAt: Type.String(),
    patch: Type.String(),
    applicationGeneration: Type.Integer(),
  },
  { additionalProperties: false },
);

const SuggestionSpanSchema = Type.Object(
  { from: Type.Integer({ minimum: 0 }), to: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

const ReviewSuggestionSchema = Type.Object(
  {
    suggestionId: Type.String({ minLength: 1 }),
    packetId: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("insertion"),
      Type.Literal("deletion"),
      Type.Literal("substitution"),
    ]),
    removedText: Type.String(),
    restorations: Type.Array(
      Type.Object(
        { at: Type.Integer({ minimum: 0 }), text: Type.String() },
        { additionalProperties: false },
      ),
    ),
    anchors: Type.Array(SuggestionSpanSchema),
    seam: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("proposed"),
      Type.Literal("accepted"),
      Type.Literal("rejected"),
      Type.Literal("withdrawn"),
    ]),
  },
  { additionalProperties: false },
);

/**
 * The idempotency ledger entry. `response` is the exact body the original
 * submission answered with and is replayed verbatim, so it is described in
 * full here: a replay that returned a partially-validated body would be a
 * different answer than the one the client already acted on.
 */
const ProposalSubmissionRecordSchema = Type.Object(
  {
    clientRequestId: Type.String(),
    requestFingerprint: Sha256,
    packetIds: Type.Array(Type.String()),
    response: Type.Object(
      {
        packetId: Type.String(),
        packetIds: Type.Array(Type.String()),
        reviewId: Type.String(),
        documentId: Type.String(),
        documentRevision: Type.Object({ sha256: Sha256 }, { additionalProperties: false }),
        reviewGeneration: Type.Integer(),
        unresolvedChunks: Type.Integer(),
        state: Type.Union([
          Type.Literal("active"),
          Type.Literal("resolved-awaiting-save"),
          Type.Literal("completed"),
          Type.Literal("cleared"),
          Type.Literal("invalidated"),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ChunkCommentSchema = Type.Object(
  {
    chunkId: Type.String(),
    comment: Type.String(),
    commentedAt: Type.String(),
  },
  { additionalProperties: false },
);

const ReviewCommentSchema = Type.Object(
  {
    text: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

const PersistedReviewStateSchema = Type.Object(
  {
    reviewId: Type.String({ minLength: 1 }),
    generation: Type.Integer({ minimum: 0 }),
    invalidated: Type.Boolean(),
    packets: Type.Array(ReviewPacketSchema),
    suggestions: Type.Array(ReviewSuggestionSchema),
    submissions: Type.Array(ProposalSubmissionRecordSchema),
    chunkComments: Type.Array(ChunkCommentSchema),
    comments: Type.Array(ReviewCommentSchema),
  },
  { additionalProperties: false },
);

export type PersistedReviewState = Static<typeof PersistedReviewStateSchema>;

// ============================================================================
// Annotation state — TextAnnotation is annotation-domain.ts's, not redeclared
// ============================================================================

const AnnotationAnchorSchema = Type.Unsafe<AnnotationAnchor>(
  Type.Union([
    Type.Object(
      {
        state: Type.Literal("range"),
        from: Type.Integer({ minimum: 0 }),
        to: Type.Integer({ minimum: 0 }),
        quotedText: Type.String(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        state: Type.Literal("point"),
        at: Type.Integer({ minimum: 0 }),
        quotedText: Type.String(),
        reason: Type.Literal("target-deleted"),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        state: Type.Literal("orphaned"),
        quotedText: Type.String(),
        reason: Type.Union([
          Type.Literal("external-drift"),
          Type.Literal("unmapped-document-change"),
        ]),
      },
      { additionalProperties: false },
    ),
  ]),
);

const AnnotationMessageSchema = Type.Unsafe<AnnotationMessage>(
  Type.Union([
    Type.Object(
      {
        messageId: Type.String(),
        author: Type.Literal("owner"),
        text: Type.String(),
        createdAt: Type.String(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        messageId: Type.String(),
        author: Type.Literal("agent"),
        clientRequestId: Type.String(),
        text: Type.String(),
        createdAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  ]),
);

const AnnotationProposalActionSchema = Type.Unsafe<AnnotationProposalAction>(
  Type.Object(
    {
      actionId: Type.String(),
      packetId: Type.String(),
      reviewId: Type.String(),
      linkedAt: Type.String(),
      terminalOutcome: Type.Optional(
        Type.Union([
          Type.Literal("accepted"),
          Type.Literal("rejected"),
          Type.Literal("mixed"),
          Type.Literal("withdrawn"),
          Type.Literal("cleared"),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
);

const TextAnnotationSchema = Type.Unsafe<TextAnnotation>(
  Type.Object(
    {
      annotationId: Type.String(),
      documentId: Type.String(),
      anchor: AnnotationAnchorSchema,
      state: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
      messages: Type.Array(AnnotationMessageSchema, { minItems: 1 }),
      proposalActions: Type.Array(AnnotationProposalActionSchema),
      createdAt: Type.String(),
      updatedAt: Type.String(),
      resolvedAt: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

// ============================================================================
// Collaboration sidecar (version 5)
// ============================================================================

export const CollaborationSidecarSchema = Type.Object(
  {
    version: Type.Literal(5),
    documentPath: Type.String({ minLength: 1 }),
    workingText: Type.String(),
    diskFenceSha256: Sha256,
    review: Type.Union([PersistedReviewStateSchema, Type.Null()]),
    annotations: Type.Object(
      {
        generation: Type.Integer({ minimum: 0 }),
        items: Type.Array(TextAnnotationSchema),
      },
      { additionalProperties: false },
    ),
    /**
     * Present only between a save's document write and the fence update that
     * follows it. A process that exits in that window leaves this behind, and
     * reattachment reads the file on disk to decide which of the two writes
     * landed instead of guessing.
     */
    pendingSave: Type.Optional(PendingSaveSchema),
  },
  { additionalProperties: false },
);

export type CollaborationSidecarData = Static<typeof CollaborationSidecarSchema>;

// ============================================================================
// Version 4 (flat, single-review) — read-only, for the deterministic lift
// ============================================================================

const ReviewSidecarV4Schema = Type.Object(
  {
    version: Type.Literal(4),
    reviewId: Type.String({ minLength: 1 }),
    documentPath: Type.String({ minLength: 1 }),
    workingText: Type.String(),
    generation: Type.Integer({ minimum: 0 }),
    diskFenceSha256: Sha256,
    invalidated: Type.Boolean(),
    packets: Type.Array(ReviewPacketSchema),
    suggestions: Type.Array(ReviewSuggestionSchema),
    submissions: Type.Array(ProposalSubmissionRecordSchema),
    chunkComments: Type.Array(ChunkCommentSchema),
    comments: Type.Array(ReviewCommentSchema),
    pendingSave: Type.Optional(PendingSaveSchema),
  },
  { additionalProperties: false },
);

export type ReviewSidecarV4Data = Static<typeof ReviewSidecarV4Schema>;

export { ReviewSidecarV4Schema };

/**
 * Deterministically nest a version-4 sidecar's review fields under `review`,
 * and give it an empty annotation set: version 4 predates annotations, so
 * every version-4 sidecar lifts to a document with none.
 */
export function migrateV4ToV5Sidecar(v4: ReviewSidecarV4Data): CollaborationSidecarData {
  return {
    version: 5,
    documentPath: v4.documentPath,
    workingText: v4.workingText,
    diskFenceSha256: v4.diskFenceSha256,
    review: {
      reviewId: v4.reviewId,
      generation: v4.generation,
      invalidated: v4.invalidated,
      packets: v4.packets,
      suggestions: v4.suggestions,
      submissions: v4.submissions,
      chunkComments: v4.chunkComments,
      comments: v4.comments,
    },
    annotations: { generation: 0, items: [] },
    ...(v4.pendingSave === undefined ? {} : { pendingSave: v4.pendingSave }),
  };
}

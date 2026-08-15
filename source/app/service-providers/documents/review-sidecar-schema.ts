/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Review sidecar schema (version 3)
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one description of what a persisted review looks like.
 *                  Declared once with TypeBox, so the runtime validator and
 *                  the TypeScript type are the same statement — the previous
 *                  hand-written type guard was a second transcription that
 *                  had to be kept in step with the interface by hand.
 *
 *                  Nothing derived is stored. Chunk counts are a function of
 *                  the two texts; persisting them creates a second answer to
 *                  a question that already has one, and a restored review
 *                  would then disagree with itself.
 *
 *                  Every object refuses unknown fields, and only the current
 *                  version is supported: this feature is unreleased, so an
 *                  older sidecar is a bug to be seen loudly, not a shape to
 *                  be migrated.
 *
 * END HEADER
 */

import { Type, type Static } from "@sinclair/typebox";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** A half-open, 1-based line interval in the merge reference. */
const RefSpanSchema = Type.Object(
  {
    from: Type.Integer(),
    to: Type.Integer(),
  },
  { additionalProperties: false },
);

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
    refSpans: Type.Array(RefSpanSchema),
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
    referenceText: Type.Optional(Type.String()),
    workingText: Type.Optional(Type.String()),
    referenceFromLine: Type.Optional(Type.Integer()),
    workingFromLine: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

const ReviewCommentSchema = Type.Object(
  {
    text: Type.String(),
    createdAt: Type.String(),
    orphanedFromChunkId: Type.Optional(Type.String()),
    decision: Type.Optional(
      Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
    ),
    referenceText: Type.Optional(Type.String()),
    workingText: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReviewSidecarSchema = Type.Object(
  {
    version: Type.Literal(4),
    reviewId: Type.String({ minLength: 1 }),
    documentPath: Type.String({ minLength: 1 }),
    referenceText: Type.String(),
    workingText: Type.String(),
    generation: Type.Integer({ minimum: 0 }),
    diskFenceSha256: Sha256,
    invalidated: Type.Boolean(),
    packets: Type.Array(ReviewPacketSchema),
    suggestions: Type.Array(ReviewSuggestionSchema),
    submissions: Type.Array(ProposalSubmissionRecordSchema),
    chunkComments: Type.Array(ChunkCommentSchema),
    comments: Type.Array(ReviewCommentSchema),
    /**
     * Present only between a save's document write and the fence update that
     * follows it. A process that exits in that window leaves this behind, and
     * reattachment reads the file on disk to decide which of the two writes
     * landed instead of guessing.
     */
    pendingSave: Type.Optional(
      Type.Object(
        {
          beforeDiskSha256: Sha256,
          afterDiskSha256: Sha256,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type ReviewSidecarData = Static<typeof ReviewSidecarSchema>;

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation domain schema and validation
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one admission boundary for AnnotationSet values.
 *                  Structural validation and aggregate semantic invariants
 *                  live together here so transports, transitions, and
 *                  persistence cannot disagree about what an annotation set
 *                  is allowed to contain.
 *
 * END HEADER
 */

import Ajv from "ajv";
import { Type } from "@sinclair/typebox";
import type {
  AnnotationAnchor,
  AnnotationMessage,
  AnnotationProposalAction,
  AnnotationSet,
  TextAnnotation,
} from "@dts/common/annotation-domain";

export const AnnotationAnchorSchema = Type.Unsafe<AnnotationAnchor>(
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

export const AnnotationMessageSchema = Type.Unsafe<AnnotationMessage>(
  Type.Union([
    Type.Object(
      {
        messageId: Type.String({ minLength: 1 }),
        author: Type.Literal("owner"),
        text: Type.String(),
        createdAt: Type.String(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        messageId: Type.String({ minLength: 1 }),
        author: Type.Literal("agent"),
        clientRequestId: Type.String({ minLength: 1 }),
        text: Type.String(),
        createdAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  ]),
);

export const AnnotationProposalActionSchema = Type.Unsafe<AnnotationProposalAction>(
  Type.Object(
    {
      actionId: Type.String({ minLength: 1 }),
      packetId: Type.String({ minLength: 1 }),
      reviewId: Type.String({ minLength: 1 }),
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

export const TextAnnotationSchema = Type.Unsafe<TextAnnotation>(
  Type.Object(
    {
      annotationId: Type.String({ minLength: 1 }),
      documentId: Type.String({ minLength: 1 }),
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

export const AnnotationSetSchema = Type.Unsafe<AnnotationSet>(
  Type.Object(
    {
      generation: Type.Integer({ minimum: 0 }),
      items: Type.Array(TextAnnotationSchema),
    },
    { additionalProperties: false },
  ),
);

const annotationSetAjv = new Ajv({ allErrors: true });
const validateAnnotationSetShape = annotationSetAjv.compile<AnnotationSet>(AnnotationSetSchema);

export type AnnotationDomainValidationCode =
  | "ANNOTATION_SCHEMA_INVALID"
  | "DUPLICATE_ANNOTATION_ID"
  | "DUPLICATE_ANNOTATION_INSTRUCTION"
  | "INVALID_ANNOTATION_INSTRUCTION"
  | "INVALID_ANNOTATION_FIRST_MESSAGE"
  | "DUPLICATE_ANNOTATION_MESSAGE_ID"
  | "DUPLICATE_ANNOTATION_ACTION_ID";

export interface AnnotationDomainValidationIssue {
  code: AnnotationDomainValidationCode;
  message: string;
  annotationIds?: readonly string[];
}

export class AnnotationDomainValidationError extends Error {
  constructor(readonly issue: AnnotationDomainValidationIssue) {
    super(issue.message);
    this.name = "AnnotationDomainValidationError";
  }
}

/**
 * Annotation reasons are user-facing prose, not identifiers. Treat Unicode,
 * casing, and runs of whitespace as presentation differences, so trivially
 * restyled copies cannot become distinct annotations.
 */
export function normalizeAnnotationInstruction(instruction: string): string {
  return instruction.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/** Called only after validateAnnotationSetShape rejected a value, so Ajv has recorded why. */
function schemaIssue(): AnnotationDomainValidationIssue {
  const errors = validateAnnotationSetShape.errors;
  if (errors === null || errors === undefined || errors.length === 0) {
    throw new Error("Annotation schema validation failed without reporting errors");
  }
  return {
    code: "ANNOTATION_SCHEMA_INVALID",
    message:
      "Stored annotation data is invalid: " +
      annotationSetAjv.errorsText(errors, { dataVar: "annotations", separator: "; " }),
  };
}

/** Return the first violated annotation-domain invariant, or undefined. */
export function annotationSetValidationIssue(value: unknown): AnnotationDomainValidationIssue | undefined {
  if (!validateAnnotationSetShape(value)) {
    return schemaIssue();
  }

  const annotationIds = new Set<string>();
  const messageIds = new Set<string>();
  const actionIds = new Set<string>();
  const instructionOwners = new Map<string, string>();

  for (const annotation of value.items) {
    if (annotationIds.has(annotation.annotationId)) {
      return {
        code: "DUPLICATE_ANNOTATION_ID",
        message: `Annotation ID ${annotation.annotationId} is duplicated.`,
        annotationIds: [annotation.annotationId],
      };
    }
    annotationIds.add(annotation.annotationId);

    const first = annotation.messages[0];
    if (first.author !== "owner") {
      return {
        code: "INVALID_ANNOTATION_FIRST_MESSAGE",
        message: `Annotation ${annotation.annotationId} must begin with an instruction from the document owner.`,
        annotationIds: [annotation.annotationId],
      };
    }

    const normalizedInstruction = normalizeAnnotationInstruction(first.text);
    if (normalizedInstruction === "") {
      return {
        code: "INVALID_ANNOTATION_INSTRUCTION",
        message: `Annotation ${annotation.annotationId} has an empty first instruction.`,
        annotationIds: [annotation.annotationId],
      };
    }
    const existing = instructionOwners.get(normalizedInstruction);
    if (existing !== undefined) {
      return {
        code: "DUPLICATE_ANNOTATION_INSTRUCTION",
        message:
          `Annotations ${existing} and ${annotation.annotationId} have the same creation instruction. ` +
          "Give each annotation a different instruction.",
        annotationIds: [existing, annotation.annotationId],
      };
    }
    instructionOwners.set(normalizedInstruction, annotation.annotationId);

    for (const message of annotation.messages) {
      if (messageIds.has(message.messageId)) {
        return {
          code: "DUPLICATE_ANNOTATION_MESSAGE_ID",
          message: `Message ID ${message.messageId} is duplicated.`,
          annotationIds: [annotation.annotationId],
        };
      }
      messageIds.add(message.messageId);
    }

    for (const action of annotation.proposalActions) {
      if (actionIds.has(action.actionId)) {
        return {
          code: "DUPLICATE_ANNOTATION_ACTION_ID",
          message: `Proposal action ID ${action.actionId} is duplicated.`,
          annotationIds: [annotation.annotationId],
        };
      }
      actionIds.add(action.actionId);
    }
  }

  return undefined;
}

export function assertValidAnnotationSet(value: unknown, context = "Annotation state"): asserts value is AnnotationSet {
  const issue = annotationSetValidationIssue(value);
  if (issue !== undefined) {
    throw new AnnotationDomainValidationError({
      ...issue,
      message: `${context}: ${issue.message}`,
    });
  }
}

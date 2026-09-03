/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pure annotation transitions
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     What every annotation mutation MEANS, as a function from
 *                  the committed annotation set to a candidate one.
 *
 *                  Nothing here writes, emits, locks, or reads a clock other
 *                  than to stamp a new record. A transition returns either a
 *                  plan — the next set, the caller's answer, and the events
 *                  a commit would owe — or a refusal that has touched
 *                  nothing. That split is what lets the application service
 *                  persist before it commits: the plan is a value, so a
 *                  refusal arriving after the plan was computed is exactly as
 *                  safe as one arriving before, and a failed write leaves the
 *                  committed set untouched because it was never replaced.
 *
 *                  Two rules are enforced here rather than at each transport,
 *                  because a transport that forgets one is the whole failure
 *                  mode. Lifecycle is owner-only: an agent request may add a
 *                  reply and link a proposal, and can reach no transition
 *                  that moves an annotation between open and resolved or
 *                  moves its anchor. And `quotedText` is never rewritten,
 *                  not by mapping, not by reattachment — the card must keep
 *                  showing what was commented on however far the document
 *                  has moved since.
 *
 * END HEADER
 */

import { randomUUID } from "crypto";
import type { ChangeDesc } from "@codemirror/state";
import type {
  AnnotationActor,
  AnnotationMessage,
  AnnotationSet,
  TextAnnotation,
} from "@dts/common/annotation-domain";
import { mapAnnotationThroughChanges } from "@common/util/annotation-anchors";
import type { AgentEventDraft } from "./review-transitions";

/**
 * The complete candidate outcome of one annotation mutation. `nextAnnotations`
 * is the whole set, not a delta: the service persists a set and commits a set,
 * so a plan that described only its own change would leave the difference for
 * the caller to reapply.
 */
export interface AnnotationMutationPlan<Response> {
  nextAnnotations: AnnotationSet;
  response: Response;
  events: AgentEventDraft[];
}

export interface AnnotationTransitionError {
  ok: false;
  code:
    | "ANNOTATION_NOT_FOUND"
    | "ANNOTATION_GENERATION_MISMATCH"
    | "ANNOTATION_RESOLVED"
    | "ANNOTATION_ORPHANED"
    | "ANNOTATION_OWNER_ONLY"
    | "INVALID_PARAMS";
  message: string;
}

/** The empty set a document starts from, and the shape a read defaults to. */
export function emptyAnnotationSet(): AnnotationSet {
  return { generation: 0, items: [] };
}

// ============================================================================
// Cloning and shared checks
// ============================================================================

/**
 * A deep-enough copy: every container a transition may append to or rewrite.
 * The anchor and the messages are replaced wholesale rather than edited, so
 * copying the arrays is enough to keep the committed set unreachable from a
 * plan that is never committed.
 */
function cloneAnnotation(annotation: TextAnnotation): TextAnnotation {
  return {
    ...annotation,
    anchor: { ...annotation.anchor },
    messages: [...annotation.messages] as TextAnnotation["messages"],
    proposalActions: annotation.proposalActions.map((action) => ({ ...action })),
  };
}

function cloneItems(annotations: AnnotationSet): TextAnnotation[] {
  return annotations.items.map(cloneAnnotation);
}

/**
 * The annotations' own fence. It moves on every annotation mutation and on no
 * review mutation, so a caller that read the panel and then decided is refused
 * only when another annotation change landed in between — a proposal applied
 * meanwhile does not invalidate the decision.
 */
function checkGeneration(
  annotations: AnnotationSet,
  expected: number,
): AnnotationTransitionError | undefined {
  if (expected === annotations.generation) {
    return undefined;
  }
  return {
    ok: false,
    code: "ANNOTATION_GENERATION_MISMATCH",
    message:
      `The document is at annotation generation ${annotations.generation}, not ` +
      `${expected}: something changed after this one was read. Re-read the ` +
      "annotations and try again.",
  };
}

/** Lifecycle is the owner's. This is invariant I3, in one place. */
function checkOwner(
  actor: AnnotationActor,
  verb: string,
): AnnotationTransitionError | undefined {
  return actor === "owner"
    ? undefined
    : {
        ok: false,
        code: "ANNOTATION_OWNER_ONLY",
        message: `Only the document owner can ${verb} an annotation.`,
      };
}

function locate(
  items: readonly TextAnnotation[],
  annotationId: string,
): TextAnnotation | AnnotationTransitionError {
  const found = items.find((candidate) => candidate.annotationId === annotationId);
  return (
    found ?? {
      ok: false,
      code: "ANNOTATION_NOT_FOUND",
      message: `No annotation ${annotationId} on this document.`,
    }
  );
}

function invalid(message: string): AnnotationTransitionError {
  return { ok: false, code: "INVALID_PARAMS", message };
}

/** A target the owner can actually have selected. */
function checkTargetRange(
  from: number,
  to: number,
  textLength: number,
): AnnotationTransitionError | undefined {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return invalid("An annotation target needs integer offsets.");
  }
  if (from < 0 || to > textLength) {
    return invalid(
      `An annotation target must lie inside the document (0..${textLength}), not ${from}..${to}.`,
    );
  }
  if (from >= to) {
    return invalid("An annotation target must cover at least one character.");
  }
  return undefined;
}

// ============================================================================
// Transitions
// ============================================================================

/**
 * Create an annotation over a selection. The owner's instruction IS the first
 * message — a card's title is derived from it (I8), so there is no title to
 * take and an empty instruction leaves nothing to derive.
 *
 * The quoted text is cut from the live buffer once, here, and never cut
 * again (I1).
 */
export function prepareAnnotationCreation(input: {
  annotations: AnnotationSet;
  actor: AnnotationActor;
  documentId: string;
  workingText: string;
  from: number;
  to: number;
  instruction: string;
  expectedAnnotationGeneration: number;
}): AnnotationMutationPlan<TextAnnotation> | AnnotationTransitionError {
  const forbidden = checkOwner(input.actor, "create");
  if (forbidden !== undefined) {
    return forbidden;
  }
  const stale = checkGeneration(input.annotations, input.expectedAnnotationGeneration);
  if (stale !== undefined) {
    return stale;
  }
  const badRange = checkTargetRange(input.from, input.to, input.workingText.length);
  if (badRange !== undefined) {
    return badRange;
  }
  if (input.instruction.trim() === "") {
    return invalid("An annotation needs an instruction: it is the annotation's first message.");
  }

  const createdAt = new Date().toISOString();
  const annotation: TextAnnotation = {
    annotationId: randomUUID(),
    documentId: input.documentId,
    anchor: {
      state: "range",
      from: input.from,
      to: input.to,
      quotedText: input.workingText.slice(input.from, input.to),
    },
    state: "open",
    messages: [
      {
        messageId: randomUUID(),
        author: "owner",
        text: input.instruction,
        createdAt,
      },
    ],
    proposalActions: [],
    createdAt,
    updatedAt: createdAt,
  };
  const nextAnnotations: AnnotationSet = {
    generation: input.annotations.generation + 1,
    items: [...cloneItems(input.annotations), annotation],
  };
  return {
    nextAnnotations,
    response: annotation,
    events: [
      {
        event: "annotation.created",
        payload: {
          documentId: input.documentId,
          annotationId: annotation.annotationId,
          annotationGeneration: nextAnnotations.generation,
        },
      },
    ],
  };
}

/**
 * Add one turn to a thread. The author is the actor, so an agent cannot post
 * as the owner, and an agent post carries the request id that wrote it.
 *
 * The replay check runs BEFORE the generation fence, for the same reason the
 * proposal ledger does: the first post already moved the generation, so a
 * retry necessarily arrives stale, and refusing it would turn a lost response
 * into a duplicate message the client can never converge on.
 */
export function prepareAnnotationMessage(input: {
  annotations: AnnotationSet;
  actor: AnnotationActor;
  annotationId: string;
  text: string;
  clientRequestId?: string;
  expectedAnnotationGeneration: number;
}): AnnotationMutationPlan<AnnotationMessage> | AnnotationTransitionError {
  const located = locate(input.annotations.items, input.annotationId);
  if ("ok" in located) {
    return located;
  }

  if (input.actor === "agent") {
    if (input.clientRequestId === undefined || input.clientRequestId === "") {
      return invalid("An agent message needs a clientRequestId so a retry can be recognised.");
    }
    const replayed = located.messages.find(
      (message) =>
        message.author === "agent" && message.clientRequestId === input.clientRequestId,
    );
    if (replayed !== undefined) {
      return { nextAnnotations: input.annotations, response: replayed, events: [] };
    }
  }

  const stale = checkGeneration(input.annotations, input.expectedAnnotationGeneration);
  if (stale !== undefined) {
    return stale;
  }
  if (input.text.trim() === "") {
    return invalid("A message needs text.");
  }
  if (located.state === "resolved") {
    return {
      ok: false,
      code: "ANNOTATION_RESOLVED",
      message: "This annotation is resolved. Reopen it before adding to its thread.",
    };
  }

  const createdAt = new Date().toISOString();
  const message: AnnotationMessage =
    input.actor === "owner"
      ? { messageId: randomUUID(), author: "owner", text: input.text, createdAt }
      : {
          messageId: randomUUID(),
          author: "agent",
          clientRequestId: input.clientRequestId!,
          text: input.text,
          createdAt,
        };

  const items = cloneItems(input.annotations);
  const target = items.find((candidate) => candidate.annotationId === input.annotationId)!;
  target.messages = [...target.messages, message] as TextAnnotation["messages"];
  target.updatedAt = createdAt;

  const nextAnnotations: AnnotationSet = {
    generation: input.annotations.generation + 1,
    items,
  };
  return {
    nextAnnotations,
    response: message,
    events: [
      {
        event: "annotation.message-added",
        payload: {
          documentId: target.documentId,
          annotationId: target.annotationId,
          annotationGeneration: nextAnnotations.generation,
        },
      },
    ],
  };
}

/** The one shape the four owner-only lifecycle moves share. */
function prepareLifecycleMove(
  input: {
    annotations: AnnotationSet;
    actor: AnnotationActor;
    annotationId: string;
    expectedAnnotationGeneration: number;
  },
  verb: string,
  event: AgentEventDraft["event"],
  apply: (
    annotation: TextAnnotation,
    items: TextAnnotation[],
    now: string,
  ) => AnnotationTransitionError | TextAnnotation[],
): AnnotationMutationPlan<TextAnnotation> | AnnotationTransitionError {
  const forbidden = checkOwner(input.actor, verb);
  if (forbidden !== undefined) {
    return forbidden;
  }
  const stale = checkGeneration(input.annotations, input.expectedAnnotationGeneration);
  if (stale !== undefined) {
    return stale;
  }
  const located = locate(input.annotations.items, input.annotationId);
  if ("ok" in located) {
    return located;
  }
  const items = cloneItems(input.annotations);
  const target = items.find((candidate) => candidate.annotationId === input.annotationId)!;
  const applied = apply(target, items, new Date().toISOString());
  if ("ok" in applied) {
    return applied;
  }
  const nextAnnotations: AnnotationSet = {
    generation: input.annotations.generation + 1,
    items: applied,
  };
  return {
    nextAnnotations,
    // The annotation as the move left it. A deletion answers with the record
    // it removed, which is the only moment that record still exists.
    response: target,
    events: [
      {
        event,
        payload: {
          documentId: located.documentId,
          annotationId: input.annotationId,
          annotationGeneration: nextAnnotations.generation,
        },
      },
    ],
  };
}

/** Resolve: the annotation leaves the primary list and keeps its thread. */
export function prepareAnnotationResolution(input: {
  annotations: AnnotationSet;
  actor: AnnotationActor;
  annotationId: string;
  expectedAnnotationGeneration: number;
}): AnnotationMutationPlan<TextAnnotation> | AnnotationTransitionError {
  return prepareLifecycleMove(input, "resolve", "annotation.resolved", (target, items, now) => {
    if (target.state === "resolved") {
      return {
        ok: false,
        code: "ANNOTATION_RESOLVED",
        message: "This annotation is already resolved.",
      };
    }
    target.state = "resolved";
    target.resolvedAt = now;
    target.updatedAt = now;
    return items;
  });
}

/** Reopen: back into the primary list, with the resolution stamp removed. */
export function prepareAnnotationReopen(input: {
  annotations: AnnotationSet;
  actor: AnnotationActor;
  annotationId: string;
  expectedAnnotationGeneration: number;
}): AnnotationMutationPlan<TextAnnotation> | AnnotationTransitionError {
  return prepareLifecycleMove(input, "reopen", "annotation.reopened", (target, items, now) => {
    if (target.state === "open") {
      return invalid("This annotation is already open.");
    }
    target.state = "open";
    delete target.resolvedAt;
    target.updatedAt = now;
    return items;
  });
}

/** Delete: the one move that ends an annotation. */
export function prepareAnnotationDeletion(input: {
  annotations: AnnotationSet;
  actor: AnnotationActor;
  annotationId: string;
  expectedAnnotationGeneration: number;
}): AnnotationMutationPlan<TextAnnotation> | AnnotationTransitionError {
  return prepareLifecycleMove(input, "delete", "annotation.deleted", (target, items) =>
    items.filter((candidate) => candidate.annotationId !== target.annotationId),
  );
}

/**
 * Reattach an orphaned or point anchor to a range the owner picked. This is
 * the ONLY way an anchor recovers a range it lost (I6): no similarity search,
 * no re-scan of the document, no guess. `quotedText` survives the move
 * unchanged (I1), so the card still shows the original target next to the new
 * one.
 */
export function prepareAnnotationReattachment(input: {
  annotations: AnnotationSet;
  actor: AnnotationActor;
  annotationId: string;
  from: number;
  to: number;
  workingText: string;
  expectedAnnotationGeneration: number;
}): AnnotationMutationPlan<TextAnnotation> | AnnotationTransitionError {
  const badRange = checkTargetRange(input.from, input.to, input.workingText.length);
  if (badRange !== undefined) {
    return badRange;
  }
  return prepareLifecycleMove(
    input,
    "reattach",
    "annotation.target-changed",
    (target, items, now) => {
      if (target.state === "resolved") {
        return {
          ok: false,
          code: "ANNOTATION_RESOLVED",
          message: "This annotation is resolved. Reopen it before reattaching it.",
        };
      }
      target.anchor = {
        state: "range",
        from: input.from,
        to: input.to,
        quotedText: target.anchor.quotedText,
      };
      target.updatedAt = now;
      return items;
    },
  );
}

// ============================================================================
// Document-driven transitions
// ============================================================================

/**
 * Carry every anchor across one edit to the document. Returns undefined when
 * no anchor moved, so ordinary typing outside every target does not spend a
 * generation and does not tell every reader to re-read.
 *
 * This is the one place an owner's edit reaches an annotation, and it runs in
 * the same transaction as the edit: the persisted anchors and the persisted
 * working text are always the same moment of the document.
 */
export function prepareAnnotationMappingThroughOwnerEdit(
  annotations: AnnotationSet,
  changes: ChangeDesc,
): AnnotationMutationPlan<void> | undefined {
  const events: AgentEventDraft[] = [];
  const items = annotations.items.map((annotation) => {
    const mapped = mapAnnotationThroughChanges(annotation.anchor, changes);
    if (!mapped.changed) {
      return annotation;
    }
    events.push({
      event: "annotation.target-changed",
      payload: {
        documentId: annotation.documentId,
        annotationId: annotation.annotationId,
        annotationGeneration: annotations.generation + 1,
      },
    });
    return { ...cloneAnnotation(annotation), anchor: mapped.anchor };
  });
  if (events.length === 0) {
    return undefined;
  }
  return {
    nextAnnotations: { generation: annotations.generation + 1, items },
    response: undefined,
    events,
  };
}

/**
 * Give up on every anchor at once. The document under them moved in a way no
 * change set describes — an external write, or a discard of the bytes the
 * anchors were measured against — and I6 says the honest answer is `orphaned`
 * plus the owner's Reattach, never a search for text that looks similar.
 *
 * Returns undefined when there is nothing left to orphan.
 */
export function prepareAnnotationOrphaning(
  annotations: AnnotationSet,
  reason: "external-drift" | "unmapped-document-change",
): AnnotationMutationPlan<void> | undefined {
  const events: AgentEventDraft[] = [];
  const items = annotations.items.map((annotation) => {
    if (annotation.anchor.state === "orphaned") {
      return annotation;
    }
    events.push({
      event: "annotation.orphaned",
      payload: {
        documentId: annotation.documentId,
        annotationId: annotation.annotationId,
        annotationGeneration: annotations.generation + 1,
      },
    });
    return {
      ...cloneAnnotation(annotation),
      anchor: {
        state: "orphaned" as const,
        quotedText: annotation.anchor.quotedText,
        reason,
      },
    };
  });
  if (events.length === 0) {
    return undefined;
  }
  return {
    nextAnnotations: { generation: annotations.generation + 1, items },
    response: undefined,
    events,
  };
}

// ============================================================================
// Proposal linkage
// ============================================================================

/**
 * Record the annotations a submitted proposal says it addresses.
 *
 * Run AFTER the review plan, because a link names the packet the claim became
 * and packet ids do not exist until then. Running it late costs nothing: both
 * plans are values, and the service persists one sidecar carrying both or
 * neither, so a refusal here leaves the review plan unapplied exactly as if
 * the check had come first.
 *
 * An addressed annotation must be this document's, open, and still anchored.
 * A proposal against a resolved thread has no reader, and one against an
 * orphaned target names a stretch of text the document no longer has.
 *
 * Returns undefined when no claim addressed anything.
 */
export function prepareAnnotationProposalLinkage(input: {
  annotations: AnnotationSet;
  reviewId: string;
  links: ReadonlyArray<{ packetId: string; annotationIds: readonly string[] }>;
}): AnnotationMutationPlan<void> | AnnotationTransitionError | undefined {
  const addressed = input.links.filter((link) => link.annotationIds.length > 0);
  if (addressed.length === 0) {
    return undefined;
  }

  const items = cloneItems(input.annotations);
  const events: AgentEventDraft[] = [];
  const linkedAt = new Date().toISOString();
  const generation = input.annotations.generation + 1;

  for (const link of addressed) {
    for (const annotationId of link.annotationIds) {
      const target = items.find((candidate) => candidate.annotationId === annotationId);
      if (target === undefined) {
        return {
          ok: false,
          code: "ANNOTATION_NOT_FOUND",
          message: `The proposal addresses annotation ${annotationId}, which is not on this document.`,
        };
      }
      if (target.state === "resolved") {
        return {
          ok: false,
          code: "ANNOTATION_RESOLVED",
          message: `The proposal addresses annotation ${annotationId}, which is resolved.`,
        };
      }
      if (target.anchor.state === "orphaned") {
        return {
          ok: false,
          code: "ANNOTATION_ORPHANED",
          message: `The proposal addresses annotation ${annotationId}, whose target is orphaned.`,
        };
      }
      target.proposalActions = [
        ...target.proposalActions,
        {
          actionId: randomUUID(),
          packetId: link.packetId,
          reviewId: input.reviewId,
          linkedAt,
        },
      ];
      target.updatedAt = linkedAt;
      events.push({
        event: "annotation.proposal-linked",
        payload: {
          documentId: target.documentId,
          annotationId: target.annotationId,
          packetId: link.packetId,
          reviewId: input.reviewId,
          annotationGeneration: generation,
        },
      });
    }
  }

  return { nextAnnotations: { generation, items }, response: undefined, events };
}

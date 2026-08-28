/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewSidecarStore
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Persistence for review sidecars: one JSON file per
 *                  reviewed document, in Electron app data (never the
 *                  workspace), keyed by canonical file path. The sidecar is
 *                  written through on every review mutation and carries the
 *                  complete suggestion state and working text. Closing a
 *                  reviewed file destroys nothing. Reopening the file
 *                  reattaches the review from here.
 *
 *                  This module only moves bytes. What a sidecar means —
 *                  when one is written, verified, restored, or deleted — is
 *                  the review application service's business; what it
 *                  contains is review-sidecar-schema.ts, one TypeBox
 *                  declaration compiled here into one Ajv validator.
 *
 *                  Fail loudly: a sidecar that cannot be read, parsed, or
 *                  written throws with the file path named. Swallowing the
 *                  error here would silently discard a review the user
 *                  believes is preserved.
 *
 * END HEADER
 */

import { sha256Text } from "@common/util/sha256";
import Ajv from "ajv";
import { promises as fs } from "fs";
import path from "path";
import writeFileAtomic from "write-file-atomic";
import { type ReviewSidecarData, ReviewSidecarSchema } from "./review-sidecar-schema";

/**
 * The sidecar file for a document. Keyed by the hash of the canonical
 * (resolved) path, so the workspace layout never leaks into app data and no
 * character of the document path needs escaping.
 */
// ponytail: path.resolve is the canonical form — symlinked aliases of one
// file get distinct sidecars. Move to realpath if that ever bites.
export function reviewSidecarFilePath(directory: string, documentPath: string): string {
  return path.join(directory, `${sha256Text(path.resolve(documentPath))}.json`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const validateReviewSidecar = new Ajv({ allErrors: true }).compile<ReviewSidecarData>(
  ReviewSidecarSchema,
);

/**
 * The rules a persisted review must satisfy, one function per rule. Each
 * throws with the sidecar's path and the entity at fault, because the caller
 * turns whatever comes out of here into the reason a write or a read was
 * refused.
 */
function assertPacketIdentity(sidecar: ReviewSidecarData, target: string): Set<string> {
  const packetIds = new Set<string>();
  for (const packet of sidecar.packets) {
    if (packetIds.has(packet.packetId)) {
      throw new Error(`Review sidecar ${target} has duplicate packet id ${packet.packetId}`);
    }
    if (packet.reviewId !== sidecar.reviewId) {
      throw new Error(
        `Review sidecar ${target} packet ${packet.packetId} belongs to another review`,
      );
    }
    packetIds.add(packet.packetId);
  }
  return packetIds;
}

/**
 * Spans that stay inside the text and never step backwards. A restoration is
 * one of these too: a point is a span of no width.
 */
function isOrderedWithin(
  spans: ReadonlyArray<{ from: number; to: number }>,
  length: number,
): boolean {
  let previous = -1;
  for (const span of spans) {
    if (span.from < 0 || span.from > span.to || span.to > length || span.from < previous) {
      return false;
    }
    previous = span.to;
  }
  return true;
}

/** Every coordinate an outstanding suggestion carries lands in the text. */
function assertSuggestionCoordinates(
  suggestion: ReviewSidecarData["suggestions"][number],
  length: number,
  target: string,
): void {
  const invalid = (what: string): Error =>
    new Error(`Review sidecar ${target} suggestion ${suggestion.suggestionId} has ${what}`);
  if (suggestion.seam < 0 || suggestion.seam > length) {
    throw invalid("an invalid seam");
  }
  const restorationPoints = suggestion.restorations.map((restoration) => ({
    from: restoration.at,
    to: restoration.at,
  }));
  if (!isOrderedWithin(restorationPoints, length)) {
    throw invalid("an invalid restoration");
  }
  if (!isOrderedWithin(suggestion.anchors, length)) {
    throw invalid("invalid anchors");
  }
}

/** The anchors a change owns text through, and the seams it only sits at. */
interface AnchorShape {
  owned: ReadonlyArray<{ from: number; to: number }>;
  seams: ReadonlyArray<{ from: number; to: number }>;
  restores: boolean;
}

/** Owns text, replaced nothing, and starts where it says it starts. */
function isCoherentInsertion(
  suggestion: ReviewSidecarData["suggestions"][number],
  shape: AnchorShape,
): boolean {
  return (
    shape.owned.length > 0 &&
    shape.seams.length === 0 &&
    shape.owned[0].from === suggestion.seam &&
    suggestion.restorations.length === 0 &&
    suggestion.removedText === ""
  );
}

/** Owns no text, and restores what stood where it sits. */
function isCoherentDeletion(
  suggestion: ReviewSidecarData["suggestions"][number],
  shape: AnchorShape,
): boolean {
  return (
    shape.owned.length === 0 &&
    shape.seams.length > 0 &&
    shape.seams[0].from === suggestion.seam &&
    shape.restores
  );
}

/**
 * Owns text and can put back what it replaced. A change whose character diff
 * falls into several parts deletes in one place and inserts in another, so a
 * substitution's deletions are seam anchors sitting between its owned ones.
 */
function isCoherentSubstitution(
  suggestion: ReviewSidecarData["suggestions"][number],
  shape: AnchorShape,
): boolean {
  return shape.owned.length > 0 && suggestion.anchors[0].from === suggestion.seam && shape.restores;
}

/** The three shapes a change comes in, and nothing else. */
function isCoherentChange(suggestion: ReviewSidecarData["suggestions"][number]): boolean {
  const shape: AnchorShape = {
    owned: suggestion.anchors.filter((anchor) => anchor.from < anchor.to),
    seams: suggestion.anchors.filter((anchor) => anchor.from === anchor.to),
    restores: suggestion.restorations.length > 0 && suggestion.removedText !== "",
  };
  if (suggestion.kind === "insertion") {
    return isCoherentInsertion(suggestion, shape);
  }
  if (suggestion.kind === "deletion") {
    return isCoherentDeletion(suggestion, shape);
  }
  return isCoherentSubstitution(suggestion, shape);
}

/** Ids are unique, every suggestion has its packet, and each one holds together. */
function assertSuggestionIntegrity(
  sidecar: ReviewSidecarData,
  packetIds: ReadonlySet<string>,
  target: string,
): Set<string> {
  const suggestionIds = new Set<string>();
  for (const suggestion of sidecar.suggestions) {
    const fault = (what: string): Error =>
      new Error(`Review sidecar ${target} suggestion ${suggestion.suggestionId} has ${what}`);
    if (suggestionIds.has(suggestion.suggestionId)) {
      throw new Error(
        `Review sidecar ${target} has duplicate suggestion id ${suggestion.suggestionId}`,
      );
    }
    suggestionIds.add(suggestion.suggestionId);
    if (!packetIds.has(suggestion.packetId)) {
      throw fault("no owning packet");
    }
    // Only an outstanding suggestion describes the working text. A decided
    // one is a ledger entry: its coordinates name the text it was decided
    // against, which later decisions and later typing move out from under it.
    if (suggestion.state !== "proposed") {
      continue;
    }
    assertSuggestionCoordinates(suggestion, sidecar.workingText.length, target);
    if (!isCoherentChange(suggestion)) {
      throw fault("incoherent change data");
    }
    if (
      suggestion.restorations.map((restoration) => restoration.text).join("") !==
      suggestion.removedText
    ) {
      throw fault("inconsistent restoration text");
    }
  }
  return suggestionIds;
}

/** No two outstanding suggestions claim the same character. */
function assertDisjointAnchors(sidecar: ReviewSidecarData, target: string): void {
  const anchors = sidecar.suggestions
    .filter((suggestion) => suggestion.state === "proposed")
    .flatMap((suggestion) =>
      suggestion.anchors
        .filter((anchor) => anchor.from < anchor.to)
        .map((anchor) => ({ ...anchor, suggestionId: suggestion.suggestionId })),
    )
    .sort((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    if (current.from < previous.to) {
      throw new Error(
        `Review sidecar ${target} suggestions ${previous.suggestionId} and ${current.suggestionId} overlap`,
      );
    }
  }
}

function assertReviewSidecarSemantics(sidecar: ReviewSidecarData, target: string): void {
  const packetIds = assertPacketIdentity(sidecar, target);
  const suggestionIds = assertSuggestionIntegrity(sidecar, packetIds, target);
  for (const comment of sidecar.chunkComments) {
    if (!suggestionIds.has(comment.chunkId)) {
      throw new Error(
        `Review sidecar ${target} comment ${comment.chunkId} has no owning suggestion`,
      );
    }
  }
  assertDisjointAnchors(sidecar, target);
}

/**
 * Persisted bytes cross into trusted review state here and nowhere else:
 * parse, validate against the one schema, then verify the payload's own path
 * hashes to the filename it was found under — a sidecar that names a
 * different document would otherwise restore that document's review onto
 * this one.
 */
function parseReviewSidecar(raw: string, target: string): ReviewSidecarData {
  let parsed: unknown;
  let parseFailure: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(raw);
    parsedOk = true;
  } catch (error) {
    parseFailure = error;
  }
  if (!parsedOk) {
    throw new Error(`Review sidecar ${target} is not valid JSON`, { cause: parseFailure });
  }
  if (!validateReviewSidecar(parsed)) {
    throw new Error(
      `Review sidecar ${target} is not a valid review sidecar: ` +
        (validateReviewSidecar.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim())
          .join("; "),
    );
  }
  assertReviewSidecarSemantics(parsed, target);
  const expectedHash = path.basename(target, ".json");
  if (expectedHash !== sha256Text(path.resolve(parsed.documentPath))) {
    throw new Error(`Review sidecar ${target} does not match its document path`);
  }
  return parsed;
}

export class ReviewSidecarStore {
  constructor(private readonly directory: string) {}

  /**
   * Write a sidecar through. write-file-atomic does the temporary file, the
   * fsync, and the rename, and already serializes concurrent writes to the
   * same path — wrapping it in a queue of our own would only add a second
   * ordering to reason about.
   */
  async write(sidecar: ReviewSidecarData): Promise<void> {
    const target = reviewSidecarFilePath(this.directory, sidecar.documentPath);
    assertReviewSidecarSemantics(sidecar, target);
    await fs.mkdir(this.directory, { recursive: true });
    await writeFileAtomic(target, JSON.stringify(sidecar), {
      encoding: "utf8",
      fsync: true,
    });
  }

  /**
   * The sidecar for a document, or undefined when none exists. A file that
   * exists but does not parse as a current-version sidecar throws.
   */
  async read(documentPath: string): Promise<ReviewSidecarData | undefined> {
    const target = reviewSidecarFilePath(this.directory, documentPath);
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
    return parseReviewSidecar(raw, target);
  }

  /** Remove a document's sidecar. Absent is fine — deletion is idempotent. */
  async delete(documentPath: string): Promise<void> {
    await fs.rm(reviewSidecarFilePath(this.directory, documentPath), { force: true });
  }

  /**
   * Every persisted sidecar. One corrupt file fails the whole listing, with
   * its path named — a partial answer would present the surviving reviews
   * as the complete set.
   */
  async list(): Promise<ReviewSidecarData[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
    return await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const target = path.join(this.directory, name);
          return parseReviewSidecar(await fs.readFile(target, "utf8"), target);
        }),
    );
  }
}

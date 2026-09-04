/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CollaborationSidecarStore
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Persistence for collaboration sidecars: one JSON file per
 *                  document, in Electron app data (never the workspace),
 *                  keyed by canonical file path. The sidecar carries a
 *                  document's whole collaboration state — its review, if one
 *                  is open, and its durable annotations, if any — written
 *                  through on every mutation. Closing a document destroys
 *                  nothing; reopening it reattaches from here.
 *
 *                  A version-4 file on disk is read as version 4, lifted to
 *                  version 5 deterministically, written back, and returned —
 *                  so a document opened once under the new schema never sees
 *                  version 4 again.
 *
 *                  A sidecar with no review and no annotations carries
 *                  nothing worth restoring, so write() deletes it rather
 *                  than persist an empty shell: the store, not each caller,
 *                  is the one place that has to remember the rule.
 *
 *                  This module only moves bytes. What a sidecar means — when
 *                  one is written, verified, restored, or deleted — is the
 *                  collaboration application service's business; what it
 *                  contains is collaboration-sidecar-schema.ts, one TypeBox
 *                  declaration compiled here into Ajv validators.
 *
 *                  Fail loudly: a sidecar that cannot be read, parsed, or
 *                  written throws with the file path named. Swallowing the
 *                  error here would silently discard collaboration state the
 *                  user believes is preserved.
 *
 * END HEADER
 */

import Ajv from "ajv";
import { promises as fs } from "fs";
import path from "path";
import writeFileAtomic from "write-file-atomic";
import { sha256Text } from "@common/util/sha256";
import {
  CollaborationSidecarSchema,
  ReviewSidecarV4Schema,
  migrateV4ToV5Sidecar,
  type CollaborationSidecarData,
  type PersistedReviewState,
  type ReviewSidecarV4Data,
} from "./collaboration-sidecar-schema";

/**
 * The sidecar file for a document. Keyed by the hash of the canonical
 * (resolved) path, so the workspace layout never leaks into app data and no
 * character of the document path needs escaping.
 */
// ponytail: path.resolve is the canonical form — symlinked aliases of one
// file get distinct sidecars. Move to realpath if that ever bites.
export function collaborationSidecarFilePath(directory: string, documentPath: string): string {
  return path.join(directory, `${sha256Text(path.resolve(documentPath))}.json`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const validateCollaborationSidecar = new Ajv({ allErrors: true }).compile<CollaborationSidecarData>(
  CollaborationSidecarSchema,
);
const validateLegacyReviewSidecar = new Ajv({ allErrors: true }).compile<ReviewSidecarV4Data>(
  ReviewSidecarV4Schema,
);

/**
 * The rules a persisted review must satisfy, one function per rule. Each
 * throws with the sidecar's path and the entity at fault, because the caller
 * turns whatever comes out of here into the reason a write or a read was
 * refused. Skipped entirely when no review is open — an annotation-only
 * sidecar has none of this to check.
 */
function assertPacketIdentity(review: PersistedReviewState, target: string): Set<string> {
  const packetIds = new Set<string>();
  for (const packet of review.packets) {
    if (packetIds.has(packet.packetId)) {
      throw new Error(`Collaboration sidecar ${target} has duplicate packet id ${packet.packetId}`);
    }
    if (packet.reviewId !== review.reviewId) {
      throw new Error(
        `Collaboration sidecar ${target} packet ${packet.packetId} belongs to another review`,
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
  suggestion: PersistedReviewState["suggestions"][number],
  length: number,
  target: string,
): void {
  const invalid = (what: string): Error =>
    new Error(`Collaboration sidecar ${target} suggestion ${suggestion.suggestionId} has ${what}`);
  if (suggestion.seam < 0 || suggestion.seam > length) {
    throw invalid("an invalid seam");
  }
  const restorationPoints = suggestion.restorations.map(
    (restoration) => ({ from: restoration.at, to: restoration.at }),
  );
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
  suggestion: PersistedReviewState["suggestions"][number],
  shape: AnchorShape,
): boolean {
  return shape.owned.length > 0 && shape.seams.length === 0 &&
    shape.owned[0].from === suggestion.seam &&
    suggestion.restorations.length === 0 && suggestion.removedText === "";
}

/** Owns no text, and restores what stood where it sits. */
function isCoherentDeletion(
  suggestion: PersistedReviewState["suggestions"][number],
  shape: AnchorShape,
): boolean {
  return shape.owned.length === 0 && shape.seams.length > 0 &&
    shape.seams[0].from === suggestion.seam && shape.restores;
}

/**
 * Owns text and can put back what it replaced. A change whose character diff
 * falls into several parts deletes in one place and inserts in another, so a
 * substitution's deletions are seam anchors sitting between its owned ones.
 */
function isCoherentSubstitution(
  suggestion: PersistedReviewState["suggestions"][number],
  shape: AnchorShape,
): boolean {
  return shape.owned.length > 0 &&
    suggestion.anchors[0].from === suggestion.seam && shape.restores;
}

/** The three shapes a change comes in, and nothing else. */
function isCoherentChange(suggestion: PersistedReviewState["suggestions"][number]): boolean {
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
  review: PersistedReviewState,
  packetIds: ReadonlySet<string>,
  target: string,
  workingTextLength: number,
): Set<string> {
  const suggestionIds = new Set<string>();
  for (const suggestion of review.suggestions) {
    const fault = (what: string): Error =>
      new Error(`Collaboration sidecar ${target} suggestion ${suggestion.suggestionId} has ${what}`);
    if (suggestionIds.has(suggestion.suggestionId)) {
      throw new Error(
        `Collaboration sidecar ${target} has duplicate suggestion id ${suggestion.suggestionId}`,
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
    assertSuggestionCoordinates(suggestion, workingTextLength, target);
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
function assertDisjointAnchors(review: PersistedReviewState, target: string): void {
  const anchors = review.suggestions
    .filter((suggestion) => suggestion.state === "proposed")
    .flatMap((suggestion) => suggestion.anchors
      .filter((anchor) => anchor.from < anchor.to)
      .map((anchor) => ({ ...anchor, suggestionId: suggestion.suggestionId })))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    if (current.from < previous.to) {
      throw new Error(
        `Collaboration sidecar ${target} suggestions ${previous.suggestionId} and ${current.suggestionId} overlap`,
      );
    }
  }
}

function assertReviewSemantics(
  review: PersistedReviewState,
  workingTextLength: number,
  target: string,
): void {
  const packetIds = assertPacketIdentity(review, target);
  const suggestionIds = assertSuggestionIntegrity(review, packetIds, target, workingTextLength);
  for (const comment of review.chunkComments) {
    if (!suggestionIds.has(comment.chunkId)) {
      throw new Error(
        `Collaboration sidecar ${target} comment ${comment.chunkId} has no owning suggestion`,
      );
    }
  }
  assertDisjointAnchors(review, target);
}

/** Every annotation id is unique, matching the identity discipline suggestions get. */
function assertAnnotationIdentity(
  annotations: CollaborationSidecarData["annotations"],
  target: string,
): void {
  const annotationIds = new Set<string>();
  for (const annotation of annotations.items) {
    if (annotationIds.has(annotation.annotationId)) {
      throw new Error(
        `Collaboration sidecar ${target} has duplicate annotation id ${annotation.annotationId}`,
      );
    }
    annotationIds.add(annotation.annotationId);
  }
}

function assertCollaborationSidecarSemantics(
  sidecar: CollaborationSidecarData,
  target: string,
): void {
  if (sidecar.review !== null) {
    assertReviewSemantics(sidecar.review, sidecar.workingText.length, target);
  }
  assertAnnotationIdentity(sidecar.annotations, target);
}

/**
 * Persisted bytes cross into trusted collaboration state here and nowhere
 * else: parse, validate against the current schema (or the legacy one, and
 * lift), then verify the payload's own path hashes to the filename it was
 * found under — a sidecar that names a different document would otherwise
 * restore that document's state onto this one.
 */
function parseJson(raw: string, target: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Collaboration sidecar ${target} is not valid JSON`, { cause: error });
  }
}

function assertMatchesFilename(sidecar: CollaborationSidecarData, target: string): void {
  const expectedHash = path.basename(target, ".json");
  if (expectedHash !== sha256Text(path.resolve(sidecar.documentPath))) {
    throw new Error(`Collaboration sidecar ${target} does not match its document path`);
  }
}

export class CollaborationSidecarStore {
  constructor(private readonly directory: string) {}

  /**
   * Write a sidecar through. write-file-atomic does the temporary file, the
   * fsync, and the rename, and already serializes concurrent writes to the
   * same path — wrapping it in a queue of our own would only add a second
   * ordering to reason about.
   *
   * A sidecar carrying neither an open review nor any annotation has
   * nothing to restore, so it is deleted instead of written: this is the one
   * place the survival rule is enforced, rather than every caller having to
   * remember it.
   */
  async write(sidecar: CollaborationSidecarData): Promise<void> {
    const target = collaborationSidecarFilePath(this.directory, sidecar.documentPath);
    if (sidecar.review === null && sidecar.annotations.items.length === 0) {
      await fs.rm(target, { force: true });
      return;
    }
    assertCollaborationSidecarSemantics(sidecar, target);
    await fs.mkdir(this.directory, { recursive: true });
    await writeFileAtomic(target, JSON.stringify(sidecar), {
      encoding: "utf8",
      fsync: true,
    });
  }

  /**
   * The sidecar for a document, or undefined when none exists. A version-4
   * file is lifted to version 5 and written back before it is returned, so a
   * second read (a later reopen, an app restart) sees version 5 directly. A
   * file that exists but parses as neither version throws.
   */
  async read(documentPath: string): Promise<CollaborationSidecarData | undefined> {
    const target = collaborationSidecarFilePath(this.directory, documentPath);
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
    return await this.parseAndMigrate(raw, target);
  }

  private async parseAndMigrate(raw: string, target: string): Promise<CollaborationSidecarData> {
    const parsed = parseJson(raw, target);
    if (validateLegacyReviewSidecar(parsed)) {
      const migrated = migrateV4ToV5Sidecar(parsed);
      assertCollaborationSidecarSemantics(migrated, target);
      assertMatchesFilename(migrated, target);
      await this.write(migrated);
      return migrated;
    }
    if (!validateCollaborationSidecar(parsed)) {
      throw new Error(
        `Collaboration sidecar ${target} is not a valid collaboration sidecar: ` +
          (validateCollaborationSidecar.errors ?? [])
            .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim())
            .join("; "),
      );
    }
    assertCollaborationSidecarSemantics(parsed, target);
    assertMatchesFilename(parsed, target);
    return parsed;
  }

  /** Remove a document's sidecar. Absent is fine — deletion is idempotent. */
  async delete(documentPath: string): Promise<void> {
    await fs.rm(collaborationSidecarFilePath(this.directory, documentPath), { force: true });
  }

  /**
   * Carry a document's sidecar to its new path when the file is renamed or
   * moved. The sidecar's on-disk name is a hash of the document path, so a
   * rename that only updates the in-memory documentPath field would strand
   * the file forever under its old hash — invisible to any future read()
   * for the new path, and orphaned app-data debris to boot. No-op when the
   * document has no sidecar to carry (nothing was ever written for it).
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const sidecar = await this.read(oldPath);
    if (sidecar === undefined) {
      return;
    }
    await this.write({ ...sidecar, documentPath: newPath });
    await fs.rm(collaborationSidecarFilePath(this.directory, oldPath), { force: true });
  }

  /**
   * Every persisted sidecar. One corrupt file fails the whole listing, with
   * its path named — a partial answer would present the surviving state as
   * the complete set.
   */
  async list(): Promise<CollaborationSidecarData[]> {
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
      names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const target = path.join(this.directory, name);
        return await this.parseAndMigrate(await fs.readFile(target, "utf8"), target);
      }),
    );
  }
}

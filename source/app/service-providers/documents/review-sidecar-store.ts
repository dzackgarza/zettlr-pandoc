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
 *                  complete review — both texts included — so closing a
 *                  reviewed file destroys nothing: reopening the file
 *                  reattaches the review from here.
 *
 *                  This module only moves bytes. What a sidecar means —
 *                  when one is written, verified, restored, or deleted —
 *                  is DocumentManager's business; what it contains is
 *                  ReviewDiffStore's (ReviewSidecarData).
 *
 *                  Fail loudly: a sidecar that cannot be read, parsed, or
 *                  written throws with the file path named. Swallowing the
 *                  error here would silently discard a review the user
 *                  believes is preserved.
 *
 * END HEADER
 */

import { promises as fs } from "fs";
import path from "path";
import type { ReviewComment } from "@dts/common/agent-api";
import type { ChunkHold } from "@dts/common/review-domain";
import type { RefSpan } from "@common/modules/review/review-chunks";
import {
  sha256Text,
  type PersistedReviewPacket,
  type ReviewSidecarData,
} from "./review-diff-store";

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

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRefSpan(value: unknown): value is RefSpan {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    isFiniteInteger(value.from) &&
    "to" in value &&
    isFiniteInteger(value.to)
  );
}

function isPersistedPacket(value: unknown): value is PersistedReviewPacket {
  return (
    typeof value === "object" &&
    value !== null &&
    "packetId" in value &&
    typeof value.packetId === "string" &&
    "reviewId" in value &&
    typeof value.reviewId === "string" &&
    "clientRequestId" in value &&
    typeof value.clientRequestId === "string" &&
    (!("description" in value) ||
      value.description === undefined ||
      typeof value.description === "string") &&
    "appliedAt" in value &&
    typeof value.appliedAt === "string" &&
    "patchFormat" in value &&
    value.patchFormat === "unified-diff" &&
    "patch" in value &&
    typeof value.patch === "string" &&
    "applicationGeneration" in value &&
    isFiniteInteger(value.applicationGeneration) &&
    "refSpans" in value &&
    Array.isArray(value.refSpans) &&
    value.refSpans.every(isRefSpan)
  );
}

function isChunkHold(value: unknown): value is ChunkHold {
  return (
    typeof value === "object" &&
    value !== null &&
    "chunkId" in value &&
    typeof value.chunkId === "string" &&
    (!("comment" in value) ||
      value.comment === undefined ||
      typeof value.comment === "string") &&
    "heldAt" in value &&
    typeof value.heldAt === "string" &&
    (!("referenceText" in value) || value.referenceText === undefined || typeof value.referenceText === "string") &&
    (!("workingText" in value) || value.workingText === undefined || typeof value.workingText === "string") &&
    (!("referenceFromLine" in value) || value.referenceFromLine === undefined || isFiniteInteger(value.referenceFromLine)) &&
    (!("workingFromLine" in value) || value.workingFromLine === undefined || isFiniteInteger(value.workingFromLine))
  );
}

function isReviewComment(value: unknown): value is ReviewComment {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    (!("orphanedFromChunkId" in value) ||
      value.orphanedFromChunkId === undefined ||
      typeof value.orphanedFromChunkId === "string")
  );
}

/**
 * The one version-1 sidecar parser. Persisted bytes cross into trusted review
 * state only after every required top-level and nested field is validated.
 */
function isReviewSidecarData(parsed: unknown): parsed is ReviewSidecarData {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    parsed.version === 1 &&
    "reviewId" in parsed &&
    typeof parsed.reviewId === "string" &&
    "documentPath" in parsed &&
    typeof parsed.documentPath === "string" &&
    "baselineText" in parsed &&
    typeof parsed.baselineText === "string" &&
    "referenceText" in parsed &&
    typeof parsed.referenceText === "string" &&
    "workingText" in parsed &&
    typeof parsed.workingText === "string" &&
    "generation" in parsed &&
    isFiniteInteger(parsed.generation) &&
    "diskFenceSha256" in parsed &&
    isSha256(parsed.diskFenceSha256) &&
    "invalidated" in parsed &&
    typeof parsed.invalidated === "boolean" &&
    "packets" in parsed &&
    Array.isArray(parsed.packets) &&
    parsed.packets.every(isPersistedPacket) &&
    "holds" in parsed &&
    Array.isArray(parsed.holds) &&
    parsed.holds.every(isChunkHold) &&
    "comments" in parsed &&
    Array.isArray(parsed.comments) &&
    parsed.comments.every(isReviewComment) &&
    "unresolvedChunks" in parsed &&
    isFiniteInteger(parsed.unresolvedChunks) &&
    "heldChunks" in parsed &&
    isFiniteInteger(parsed.heldChunks) &&
    "savedAt" in parsed &&
    typeof parsed.savedAt === "string"
  );
}

function parseReviewSidecar(raw: string, target: string): ReviewSidecarData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Review sidecar ${target} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!isReviewSidecarData(parsed)) {
    throw new Error(`Review sidecar ${target} is not a version-1 review sidecar`);
  }
  const expectedHash = path.basename(target, ".json");
  if (expectedHash !== sha256Text(path.resolve(parsed.documentPath))) {
    throw new Error(`Review sidecar ${target} does not match its document path`);
  }
  return parsed;
}

export class ReviewSidecarStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  /** Write a sidecar through, atomically (write-then-rename). */
  async write(sidecar: ReviewSidecarData): Promise<void> {
    const target = reviewSidecarFilePath(this.directory, sidecar.documentPath);
    const previous = this.pendingWrites.get(target);
    const start = previous === undefined ? Promise.resolve() : previous.catch(() => undefined);
    const pending = start.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(sidecar), "utf8");
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    this.pendingWrites.set(target, pending);
    try {
      await pending;
    } finally {
      if (this.pendingWrites.get(target) === pending) {
        this.pendingWrites.delete(target);
      }
    }
  }

  /**
   * The sidecar for a document, or undefined when none exists. A file that
   * exists but does not parse as a version-1 sidecar throws.
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
    const parsed = parseReviewSidecar(raw, target);
    if (path.resolve(parsed.documentPath) !== path.resolve(documentPath)) {
      throw new Error(`Review sidecar ${target} does not match the requested document path`);
    }
    return parsed;
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
      names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const target = path.join(this.directory, name);
        return parseReviewSidecar(await fs.readFile(target, "utf8"), target);
      }),
    );
  }
}

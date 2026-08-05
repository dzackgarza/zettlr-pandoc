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

import Ajv from "ajv";
import { promises as fs } from "fs";
import path from "path";
import writeFileAtomic from "write-file-atomic";
import { sha256Text } from "./review-diff-store";
import { ReviewSidecarSchema, type ReviewSidecarData } from "./review-sidecar-schema";

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
 * Persisted bytes cross into trusted review state here and nowhere else:
 * parse, validate against the one schema, then verify the payload's own path
 * hashes to the filename it was found under — a sidecar that names a
 * different document would otherwise restore that document's review onto
 * this one.
 */
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
  if (!validateReviewSidecar(parsed)) {
    throw new Error(
      `Review sidecar ${target} is not a version-2 review sidecar: ` +
        (validateReviewSidecar.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim())
          .join("; "),
    );
  }
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
    await fs.mkdir(this.directory, { recursive: true });
    await writeFileAtomic(target, JSON.stringify(sidecar), {
      encoding: "utf8",
      fsync: true,
    });
  }

  /**
   * The sidecar for a document, or undefined when none exists. A file that
   * exists but does not parse as a version-2 sidecar throws.
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
      names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const target = path.join(this.directory, name);
        return parseReviewSidecar(await fs.readFile(target, "utf8"), target);
      }),
    );
  }
}

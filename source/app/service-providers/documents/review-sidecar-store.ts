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

import fs from "fs";
import path from "path";
import { sha256Text, type ReviewSidecarData } from "./review-diff-store";

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

export class ReviewSidecarStore {
  constructor(private readonly directory: string) {}

  /** Write a sidecar through, atomically (write-then-rename). */
  write(sidecar: ReviewSidecarData): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const target = reviewSidecarFilePath(this.directory, sidecar.documentPath);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(sidecar), "utf8");
    fs.renameSync(temporary, target);
  }

  /**
   * The sidecar for a document, or undefined when none exists. A file that
   * exists but does not parse as a version-1 sidecar throws.
   */
  read(documentPath: string): ReviewSidecarData | undefined {
    const target = reviewSidecarFilePath(this.directory, documentPath);
    let raw: string;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    return this.parse(raw, target);
  }

  /** Remove a document's sidecar. Absent is fine — deletion is idempotent. */
  delete(documentPath: string): void {
    fs.rmSync(reviewSidecarFilePath(this.directory, documentPath), { force: true });
  }

  /**
   * Every persisted sidecar. One corrupt file fails the whole listing, with
   * its path named — a partial answer would present the surviving reviews
   * as the complete set.
   */
  list(): ReviewSidecarData[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const target = path.join(this.directory, name);
        return this.parse(fs.readFileSync(target, "utf8"), target);
      });
  }

  private parse(raw: string, target: string): ReviewSidecarData {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Review sidecar ${target} is not valid JSON: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { reviewId?: unknown }).reviewId !== "string" ||
      typeof (parsed as { documentPath?: unknown }).documentPath !== "string" ||
      typeof (parsed as { referenceText?: unknown }).referenceText !== "string" ||
      typeof (parsed as { workingText?: unknown }).workingText !== "string" ||
      typeof (parsed as { diskFenceSha256?: unknown }).diskFenceSha256 !== "string" ||
      !Array.isArray((parsed as { packets?: unknown }).packets)
    ) {
      throw new Error(`Review sidecar ${target} is not a version-1 review sidecar`);
    }
    return parsed as ReviewSidecarData;
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        sha256Text
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one SHA-256-of-text function in the application.
 *
 *                  Content hashes are a wire contract: the renderer computes
 *                  the hash it binds a review decision to, and main compares
 *                  that string against its own working text. Two
 *                  implementations — node:crypto in main, something else in
 *                  the renderer — would be two chances to disagree over
 *                  encoding, and a disagreement here reads as a mismatched
 *                  precondition rather than as a bug. @noble/hashes runs
 *                  identically in both processes, so there is one
 *                  implementation and nothing to keep in step.
 *
 * END HEADER
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** The lowercase hex SHA-256 of `text` encoded as UTF-8. */
export function sha256Text(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

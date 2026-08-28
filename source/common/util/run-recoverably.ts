/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recoverable renderer-operation boundary
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single renderer-side boundary for recoverable
 *                  reference-workspace failures (issue #1, review B8). A
 *                  recoverable operation that rejects surfaces as EXACTLY
 *                  ONE closable error toast naming the failed operation plus
 *                  the typed outcome { status: 'failed' } — never a silent
 *                  console-only line, never fabricated fallback data, and
 *                  never an escaped rejection (which would raise the
 *                  uncloseable runtime-error overlay the contract forbids).
 *
 *                  This module lives in common/ so the markdown-editor
 *                  modules (reference navigation, the @-completion append
 *                  continuation) can route through
 *                  it; the window-level
 *                  win-main/util/recoverable-reference-errors.ts boundary
 *                  delegates here, keeping one implementation of the
 *                  surfacing semantics.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import showToast from "@common/util/show-toast";

/** The typed outcome of a recoverable operation. */
export type RecoverableOutcome<T> = { status: "ok"; value: T } | { status: "failed" };

/**
 * Runs a recoverable operation, surfacing any rejection as one closable
 * error toast plus a typed 'failed' outcome, per the module contract above.
 * This is the sanctioned boundary renderer translating a structured failure
 * into the user-facing protocol: it never rethrows, never returns partial
 * data, and callers branch on the returned status.
 *
 * @param   {() => Promise<T>}  operation       The operation to run
 * @param   {string}            operationLabel  The user-facing operation name
 *
 * @return  {Promise<RecoverableOutcome<T>>}    The typed outcome
 */
export async function runRecoverably<T>(
  operation: () => Promise<T>,
  operationLabel: string,
): Promise<RecoverableOutcome<T>> {
  return await operation()
    .then((value): RecoverableOutcome<T> => ({ status: "ok", value }))
    .catch((err): RecoverableOutcome<T> => {
      // Exactly one closable error toast naming the failed operation, plus
      // the typed outcome. The rejection never escapes; the console line
      // keeps the raw diagnostic available.
      console.error(`Reference operation failed (${operationLabel})`, err);
      const detail = err instanceof Error ? err.message : String(err);
      showToast(trans("%s failed: %s", operationLabel, detail), "error");
      return { status: "failed" };
    });
}

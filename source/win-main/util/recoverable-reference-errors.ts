/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recoverable reference-error boundary
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The renderer-side boundary for recoverable reference
 *                  workspace failures (issue #1, Phase 8; workstream 5).
 *                  The contract: recoverable indexing, preview, navigation,
 *                  and workspace-edit failures surface as STRUCTURED errors
 *                  and CLOSABLE toasts — never as an uncloseable
 *                  runtime-error overlay and never as silent log lines.
 *
 *                  This module is the single boundary the MainEditor.vue /
 *                  App.vue reference-provider invocations route through
 *                  (the Vue wiring is thin; the surfacing semantics live
 *                  here).
 *
 *                  CONTRACT (locked red by the
 *                  test/reference-error-surface probe trio —
 *                  reference-error-surface{-build.cjs,-entry.ts,-probe.cjs,
 *                  .spec.ts}):
 *
 *                  - invokeReferenceProviderRecoverably(ipcInvoke, message,
 *                    operationLabel) forwards message on the
 *                    'reference-provider' channel through the INJECTED
 *                    ipcInvoke seam (production passes ipcRenderer.invoke).
 *
 *                  - On success it returns { status: 'ok', value } with the
 *                    provider's untouched result.
 *
 *                  - On rejection it:
 *                    - shows EXACTLY ONE closable error toast (the
 *                      showToast('…', 'error') surface) whose message names
 *                      operationLabel, so the user learns WHICH operation
 *                      failed and can dismiss the notice;
 *                    - returns the typed outcome { status: 'failed' } —
 *                      never fabricated fallback data, never a partial
 *                      result;
 *                    - NEVER rethrows and never leaks an unhandled
 *                      rejection: an escaped rejection is what produces the
 *                      uncloseable runtime-error overlay this contract
 *                      forbids. This function is the sanctioned boundary
 *                      renderer translating the structured failure into the
 *                      user-facing protocol; callers branch on status and
 *                      skip their update — the editor stays interactive.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import showToast from '@common/util/show-toast'
import type { ReferenceProviderInvoker } from '@common/modules/markdown-editor/util/live-buffer-reporter'

/** The typed outcome of a recoverable reference-provider invocation. */
export type RecoverableReferenceOutcome<T> =
  | { status: 'ok', value: T }
  | { status: 'failed' }

/**
 * Invokes a reference-provider command, surfacing any rejection as one
 * closable error toast plus a typed 'failed' outcome, per the module
 * contract above.
 *
 * @param   {ReferenceProviderInvoker}  ipcInvoke       The renderer ipc seam
 * @param   {object}                    message         The provider command message
 * @param   {string}                    operationLabel  The user-facing operation name
 *
 * @return  {Promise<RecoverableReferenceOutcome<T>>}   The typed outcome
 */
export async function invokeReferenceProviderRecoverably<T> (
  ipcInvoke: ReferenceProviderInvoker,
  message: { command: string, payload?: unknown },
  operationLabel: string
): Promise<RecoverableReferenceOutcome<T>> {
  return await ipcInvoke('reference-provider', message)
    .then((value): RecoverableReferenceOutcome<T> => ({ status: 'ok', value: value as T }))
    .catch((err): RecoverableReferenceOutcome<T> => {
      // The sanctioned boundary: exactly one closable error toast naming the
      // failed operation, plus the typed outcome. The rejection never
      // escapes, so the uncloseable runtime-error overlay never appears; the
      // console line keeps the raw diagnostic available.
      console.error(`Reference operation failed (${operationLabel})`, err)
      const detail = err instanceof Error ? err.message : String(err)
      showToast(trans('%s failed: %s', operationLabel, detail), 'error')
      return { status: 'failed' }
    })
}

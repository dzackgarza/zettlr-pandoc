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
 *                  Proof: test/reference-error-surface.spec.ts.
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

import { type RecoverableOutcome, runRecoverably } from "@common/util/run-recoverably";
import type { ReferenceProviderIPCContract } from "source/app/service-providers/references";

type ReferenceCommand = keyof ReferenceProviderIPCContract;

/** The message of one reference-provider command. */
export type ReferenceProviderMessage<K extends ReferenceCommand> = {
  command: K;
} & ReferenceProviderIPCContract[K]["request"];

/** The answer that the reference provider declares for one command. */
export type ReferenceProviderResponse<K extends ReferenceCommand> =
  ReferenceProviderIPCContract[K]["response"];

/** The renderer ipc seam the invocations travel through (ipcRenderer.invoke). */
export type ReferenceProviderInvoker<K extends ReferenceCommand> = (
  channel: "reference-provider",
  message: ReferenceProviderMessage<K>,
) => Promise<ReferenceProviderResponse<K>>;

/**
 * Invokes a reference-provider command, surfacing any rejection as one
 * closable error toast plus a typed 'failed' outcome, per the module
 * contract above. The value of an 'ok' outcome is the answer that the
 * provider declares for the command.
 *
 * @param   ipcInvoke       The renderer ipc seam
 * @param   message         The provider command message
 * @param   operationLabel  The user-facing operation name
 */
export async function invokeReferenceProviderRecoverably<K extends ReferenceCommand>(
  ipcInvoke: ReferenceProviderInvoker<K>,
  message: ReferenceProviderMessage<K>,
  operationLabel: string,
): Promise<RecoverableOutcome<ReferenceProviderResponse<K>>> {
  return await runRecoverably(
    async () => await ipcInvoke("reference-provider", message),
    operationLabel,
  );
}

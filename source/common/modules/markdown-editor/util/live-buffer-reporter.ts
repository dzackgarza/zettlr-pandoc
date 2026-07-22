/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Live-buffer reporter
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The MainEditor-owned production half of the live-overlay
 *                  authority contract (issue #1). The ReferenceProvider
 *                  accepts 'report-live-buffer' / 'drop-live-buffer' on the
 *                  'reference-provider' ipc channel (contract locked by
 *                  test/reference-provider-shell.spec.ts); this module is
 *                  the pure, injectable unit MainEditor.vue wires to its
 *                  editor 'change' events (MarkdownEditor emits 'change' on
 *                  every docChanged update) and to document close/switch
 *                  (onBeforeUnmount / file-path change): the Vue wiring is
 *                  thin; the semantics live here.
 *
 *                  CONTRACT (locked red by test/live-buffer-reporter.spec.ts):
 *
 *                  - createLiveBufferReporter(ipcInvoke, scheduler,
 *                    debounceMs?) returns a reporter whose dependencies are
 *                    INJECTED: ipcInvoke is the renderer's
 *                    ipcRenderer.invoke seam and scheduler owns deferred
 *                    execution (production passes a setTimeout-backed
 *                    scheduler; specs pass a manually-fired fake so debounce
 *                    is proven headlessly without wall-clock waits).
 *
 *                  - reportChange(documentPath, content, generation)
 *                    DEBOUNCES per document: it schedules (or reschedules,
 *                    cancelling the pending task) one delivery debounceMs in
 *                    the future. Nothing is invoked before the scheduled
 *                    task fires. When it fires, EXACTLY ONE invocation is
 *                    sent, carrying the LATEST reported content/generation
 *                    for that document:
 *
 *                      ipcInvoke('reference-provider', {
 *                        command: 'report-live-buffer',
 *                        payload: {
 *                          snapshot: extractReferences(documentPath, content),
 *                          generation
 *                        }
 *                      })
 *
 *                    The snapshot comes from the SAME shared extractor FSAL
 *                    and the editor use — never a reduced or bespoke
 *                    extraction.
 *
 *                  - Generations are MONOTONIC per document: the reporter
 *                    never sends a report whose generation is <= the last
 *                    generation it delivered for that documentPath (a stale
 *                    out-of-order report is dropped, not reordered).
 *
 *                  - Documents debounce INDEPENDENTLY: a pending report for
 *                    one document never coalesces with, delays, or cancels
 *                    another document's report.
 *
 *                  - dropDocument(documentPath) cancels any pending
 *                    scheduled report for that document and IMMEDIATELY
 *                    (no debounce) invokes
 *                    ipcInvoke('reference-provider', {
 *                      command: 'drop-live-buffer',
 *                      payload: { documentPath }
 *                    })
 *                    so a closed/switched-away buffer reverts to its saved
 *                    FSAL snapshot without waiting out a debounce window.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { extractReferences } from '@common/pandoc-util/extract-references'
import { runRecoverably } from '@common/util/run-recoverably'

/** The renderer ipc seam the reporter delivers through (ipcRenderer.invoke). */
export type ReferenceProviderInvoker =
  (channel: 'reference-provider', message: { command: string, payload?: unknown }) => Promise<unknown>

/** A scheduled deferred delivery that can be cancelled before it fires. */
export interface LiveBufferScheduledTask {
  cancel: () => void
}

/**
 * The injected deferred-execution seam. Production backs this with
 * setTimeout/clearTimeout; specs fire the recorded callbacks manually.
 */
export interface LiveBufferScheduler {
  schedule: (callback: () => void, delayMs: number) => LiveBufferScheduledTask
}

/** The debounce window applied between a doc change and its live report. */
export const LIVE_BUFFER_DEBOUNCE_MS = 500

/** The per-editor live-buffer reporting surface MainEditor.vue drives. */
export interface LiveBufferReporter {
  reportChange: (documentPath: string, content: string, generation: number) => void
  dropDocument: (documentPath: string) => void
}

/** One not-yet-delivered change report, replaced wholesale on every edit. */
interface PendingLiveReport {
  content: string
  generation: number
  task: LiveBufferScheduledTask
}

/**
 * Creates the live-buffer reporter, per the module contract above.
 *
 * @param   {ReferenceProviderInvoker}  ipcInvoke   The renderer ipc seam
 * @param   {LiveBufferScheduler}       scheduler   The deferred-execution seam
 * @param   {number}                    debounceMs  The debounce window
 *
 * @return  {LiveBufferReporter}                    The reporter
 */
export function createLiveBufferReporter (
  ipcInvoke: ReferenceProviderInvoker,
  scheduler: LiveBufferScheduler,
  debounceMs: number = LIVE_BUFFER_DEBOUNCE_MS
): LiveBufferReporter {
  // Per-document state: the pending (debounced) report and the last
  // generation actually delivered. Documents never share entries, so they
  // debounce independently and stay individually monotonic.
  const pending = new Map<string, PendingLiveReport>()
  const deliveredGenerations = new Map<string, number>()

  /** Fires when a document's debounce window elapses: delivers the LATEST
   *  reported content/generation, unless a newer generation already went out. */
  function deliver (documentPath: string): void {
    const report = pending.get(documentPath)
    if (report === undefined) {
      return // Cancelled (dropDocument) or already delivered.
    }
    pending.delete(documentPath)

    const lastDelivered = deliveredGenerations.get(documentPath)
    if (lastDelivered !== undefined && report.generation <= lastDelivered) {
      return // Stale out-of-order report: dropped, never reordered.
    }
    deliveredGenerations.set(documentPath, report.generation)

    // A rejected delivery surfaces through the recoverable boundary
    // (review B8): one closable error toast naming the operation, never a
    // silent console-only line. The wire invocation itself is unchanged.
    void runRecoverably(async () => await ipcInvoke('reference-provider', {
      command: 'report-live-buffer',
      payload: {
        snapshot: extractReferences(documentPath, report.content),
        generation: report.generation
      }
    }), trans('Live reference indexing of %s', documentPath))
  }

  return {
    reportChange: (documentPath: string, content: string, generation: number): void => {
      // Reschedule: the pending task dies, the fresh content/generation
      // replace it, and one delivery sits debounceMs in the future.
      pending.get(documentPath)?.task.cancel()
      pending.set(documentPath, {
        content,
        generation,
        task: scheduler.schedule(() => { deliver(documentPath) }, debounceMs)
      })
    },
    dropDocument: (documentPath: string): void => {
      // The pending report dies with the document; the drop goes out
      // immediately so the provider reverts to the saved FSAL snapshot
      // without waiting out a debounce window.
      const report = pending.get(documentPath)
      if (report !== undefined) {
        report.task.cancel()
        pending.delete(documentPath)
      }
      void runRecoverably(async () => await ipcInvoke('reference-provider', {
        command: 'drop-live-buffer',
        payload: { documentPath }
      }), trans('Releasing the live reference overlay of %s', documentPath))
    }
  }
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Operation-channel IPC contract fixtures
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Compile-time fixtures for the typed document operation
 *                  channels, checked by `bun run typecheck` (test/ is in the
 *                  tsconfig include). This is deliberately not a mocha spec:
 *                  there is nothing to observe at runtime, and a
 *                  @ts-expect-error that stops being an error is itself a
 *                  compile failure, so a channel that loses its typing fails
 *                  the gate with no test process involved.
 *
 *                  No second map records these contracts: every type below
 *                  comes from DocumentIpcHandlers, which sits next to the
 *                  ipcMain handlers that implement it. The negative fixtures
 *                  anchor on that map directly, because window.ipc.invoke
 *                  falls back to upstream Zettlr's untyped signature for
 *                  every non-operation channel and would swallow a bad call.
 *
 * END HEADER
 */

import type { DocumentIpcHandlers } from 'source/app/service-providers/documents'
import type { SaveFileResult } from '@dts/common/documents'

declare const invoke: ZettlrIpcInvoke

/** A channel's payload, as its owning handler declares it. */
type InputOf<C extends keyof DocumentIpcHandlers> = Parameters<DocumentIpcHandlers[C]>[0]

/** The handler's own response type reaches the call site. */
export async function respondsWithTheHandlerType (): Promise<SaveFileResult> {
  return await invoke('documents:save-file', { path: '/tmp/a.md' })
}

/** A valid payload compiles against the typed overload. */
export async function acceptsAFencedDecision (): Promise<void> {
  await invoke('documents:decide-review-chunk', {
    reviewId: 'r1',
    chunkId: 'c1',
    decision: 'accept',
    expectedReviewGeneration: 3,
    expectedWorkingSha256: '0'.repeat(64)
  })
}

// @ts-expect-error An operation name outside the schema is not a channel.
export const unknownChannel: keyof DocumentIpcHandlers = 'documents:decide-review-chunks'

// @ts-expect-error A decision without its fence fields has no contract.
export const missingFence: InputOf<'documents:decide-review-chunk'> = {
  reviewId: 'r1',
  chunkId: 'c1',
  decision: 'accept'
}

export const wrongFenceType: InputOf<'documents:clear-review'> = {
  reviewId: 'r1',
  // @ts-expect-error The generation is a number, not prose.
  expectedReviewGeneration: 'three',
  expectedWorkingSha256: '0'.repeat(64)
}

export const commentCarriesNoHash: InputOf<'documents:add-review-comment'> = {
  reviewId: 'r1',
  text: 'note',
  expectedReviewGeneration: 3,
  // @ts-expect-error A comment fences on the generation alone; there is no working hash.
  expectedWorkingSha256: '0'.repeat(64)
}

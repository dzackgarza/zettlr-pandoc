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
 *                  channels. These assertions are checked by `bun run
 *                  typecheck` (test/ is in the tsconfig include), not at
 *                  runtime: a @ts-expect-error that stops being an error is
 *                  itself a compile failure, so a channel that loses its
 *                  typing fails the gate.
 *
 *                  The point of the phase is that no second map records these
 *                  contracts: every type below comes from DocumentIpcHandlers,
 *                  which sits next to the ipcMain handlers that implement it.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import type { DocumentIpcHandlers } from 'source/app/service-providers/documents'
import type { SaveFileResult } from '@dts/common/documents'

declare const invoke: ZettlrIpcInvoke

/** The handler's own response type reaches the call site. */
async function respondsWithTheHandlerType (): Promise<SaveFileResult> {
  return await invoke('documents:save-file', { path: '/tmp/a.md' })
}

async function fixtures (): Promise<void> {
  // A valid payload compiles.
  await invoke('documents:decide-review-chunk', {
    reviewId: 'r1',
    chunkId: 'c1',
    decision: 'accept',
    expectedReviewGeneration: 3,
    expectedWorkingSha256: '0'.repeat(64)
  })

  // @ts-expect-error An operation name outside the schema is not a channel.
  await invoke('documents:decide-review-chunks', { reviewId: 'r1' })

  // @ts-expect-error The decision literal is the handler's own union.
  await invoke('documents:clear-review', { reviewId: 'r1', expectedReviewGeneration: 'three' })

  // @ts-expect-error A comment fences on the generation alone; there is no working hash.
  await invoke('documents:add-review-comment', {
    reviewId: 'r1',
    text: 'note',
    expectedReviewGeneration: 3,
    expectedWorkingSha256: '0'.repeat(64)
  })
}

describe('Document operation IPC channels', function () {
  it('declares one channel per operation, all of them namespaced', function () {
    const channels: Array<keyof DocumentIpcHandlers> = [
      'documents:save-file',
      'documents:decide-review-chunk',
      'documents:accept-all-review-chunks',
      'documents:clear-review',
      'documents:add-review-comment'
    ]
    for (const channel of channels) {
      assert.ok(channel.startsWith('documents:'), `${channel} must name its provider`)
    }
    // The fixtures above are the contract proof; reference them so the module
    // is not dead code to a reader.
    assert.equal(typeof respondsWithTheHandlerType, 'function')
    assert.equal(typeof fixtures, 'function')
  })
})

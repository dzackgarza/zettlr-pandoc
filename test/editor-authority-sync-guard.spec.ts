/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document-authority sync guard (format-on-save ordering)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Format-on-save writes through the document authority, so the
 *                  file only receives the formatted bytes once the format's
 *                  collab update has been confirmed there. This spec drives the
 *                  wait that orders those two steps against REAL @codemirror
 *                  collab state: it must fail when the backstop expires with
 *                  updates still unsent (a save chained onto a silent resolve
 *                  persists the pre-format text and reports success), and it
 *                  must resolve as soon as the authority confirms them.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { collab, receiveUpdates, sendableUpdates } from '@codemirror/collab'
import { EditorState } from '@codemirror/state'
import { whenAuthoritySynced } from 'source/common/modules/markdown-editor/util/when-authority-synced'

/** A collab-backed state whose text has been reformatted but not yet confirmed. */
function stateWithUnsentFormat (): EditorState {
  const original = EditorState.create({
    doc: 'The cat sat.  The dog ran.\n',
    extensions: [ collab({ startVersion: 0 }) ]
  })
  const formatted = original.update({
    changes: { from: 0, to: original.doc.length, insert: 'The cat sat.\nThe dog ran.\n' }
  }).state
  assert.equal(sendableUpdates(formatted).length, 1, 'the reformat must be pending for the authority')
  return formatted
}

/** Applies the authority's confirmation of everything currently unsent. */
function confirmPending (state: EditorState): EditorState {
  const updates = sendableUpdates(state).map(u => ({ clientID: u.clientID, changes: u.changes }))
  return state.update(receiveUpdates(state, updates)).state
}

describe('Document-authority sync guard (format-on-save ordering)', function () {
  it('fails when the backstop expires with updates still unsent', async function () {
    const state = stateWithUnsentFormat()

    await assert.rejects(
      async () => { await whenAuthoritySynced(() => state, 60) },
      /has not confirmed 1 pending update/,
      'an unmet ordering guarantee must throw; resolving lets the caller save the pre-format text as an ordinary success'
    )
  })

  it('resolves once the authority confirms the pending update', async function () {
    let state = stateWithUnsentFormat()
    const synced = whenAuthoritySynced(() => state, 2000)

    setTimeout(() => { state = confirmPending(state) }, 40)

    await synced // Must not throw: the authority now holds the formatted bytes
    assert.equal(sendableUpdates(state).length, 0)
    assert.equal(state.doc.toString(), 'The cat sat.\nThe dog ran.\n')
  })

  it('resolves immediately when there is nothing left to send', async function () {
    const state = confirmPending(stateWithUnsentFormat())

    // A zero backstop would throw on the very first check if anything were
    // still unsent, so this also proves the wait reads real collab state.
    await whenAuthoritySynced(() => state, 0)
  })
})

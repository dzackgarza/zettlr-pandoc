/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IPC type contract tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Compile-time proofs for renderer-to-main IPC request
 *                  contracts. The literal assignments fail under vue-tsc
 *                  when a request boundary admits the wrong message shape.
 *
 * END HEADER
 */

import assert from 'assert'
import 'mocha'
import type { ApplicationIPCAPI } from 'source/app/service-providers/commands'
import type { IPCAPI } from 'source/app/service-providers/provider-contract'

type BareIPC = IPCAPI<{ 'bare-command': unknown }>

type BareCommandAccepted =
  { command: 'bare-command' } extends BareIPC ? true : false

type ArbitraryPayloadRejected =
  { command: 'bare-command', payload: 42 } extends BareIPC ? false : true

const bareCommandAccepted: BareCommandAccepted = true
const arbitraryPayloadRejected: ArbitraryPayloadRejected = true

type OpenAttachmentIPC = Extract<
ApplicationIPCAPI,
{ command: 'open-attachment' }
>

type CompleteOpenAttachmentAccepted = {
  command: 'open-attachment'
  payload: { citekey: 'reference-key', filePath: '/workspace/document.md' }
} extends OpenAttachmentIPC
  ? true
  : false

type MissingAttachmentFilePathRejected = {
  command: 'open-attachment'
  payload: { citekey: 'reference-key' }
} extends OpenAttachmentIPC
  ? false
  : true

const completeOpenAttachmentAccepted: CompleteOpenAttachmentAccepted = true
const missingAttachmentFilePathRejected: MissingAttachmentFilePathRejected = true

describe('IPC type contracts', function () {
  it('admits a bare no-argument command and rejects an arbitrary payload', function () {
    assert.strictEqual(bareCommandAccepted, true)
    assert.strictEqual(arbitraryPayloadRejected, true)
  })

  it('requires the source file path when opening a citation attachment', function () {
    assert.strictEqual(completeOpenAttachmentAccepted, true)
    assert.strictEqual(missingAttachmentFilePathRejected, true)
  })
})

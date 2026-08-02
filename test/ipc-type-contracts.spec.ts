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
import type { CiteprocProviderIPCAPI } from 'source/app/service-providers/citeproc'
import type { LRTIPCAsyncMessage } from 'source/app/service-providers/long-running-tasks'
import type { DictionaryProviderIPCAPI, MenuProviderIPCAPI } from 'source/types/renderer/ipc-bridge'

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

type RequiredCommandPayload<C extends ApplicationIPCAPI['command']> = Extract<
ApplicationIPCAPI,
{ command: C }
>

type DirectoryWithoutPayloadRejected = {
  command: 'dir-new'
} extends RequiredCommandPayload<'dir-new'> ? false : true

type DirectoryWithoutPathRejected = {
  command: 'dir-new'
  payload: { name: 'new-directory' }
} extends RequiredCommandPayload<'dir-new'> ? false : true

type FileWithoutPayloadRejected = {
  command: 'file-new'
} extends RequiredCommandPayload<'file-new'> ? false : true

type DuplicateWithoutWindowRejected = {
  command: 'file-duplicate'
  payload: { path: '/workspace/document.md', leafId: 'leaf' }
} extends RequiredCommandPayload<'file-duplicate'> ? false : true

type SyncCitationCannotInvoke = {
  command: 'get-citation-sync'
  payload: { database: 'main', citations: [], composite: false }
} extends Exclude<CiteprocProviderIPCAPI, { command: 'get-citation-sync' }> ? false : true

type SyncLRTCannotInvoke = {
  command: 'abort-task'
  payload: { id: 'task' }
} extends LRTIPCAsyncMessage ? false : true

type DictionaryPayloadMustBeStrings = {
  command: 'set-user-dictionary'
  payload: ['word']
} extends DictionaryProviderIPCAPI ? true : false

type DictionaryPayloadRejectsNumbers = {
  command: 'set-user-dictionary'
  payload: [42]
} extends DictionaryProviderIPCAPI ? false : true

type ContextMenuPayloadRequiresCoordinates = {
  command: 'display-native-context-menu'
  payload: { menu: [], x: 1, y: 2 }
} extends MenuProviderIPCAPI ? true : false

type ContextMenuPayloadRejectsMissingCoordinates = {
  command: 'display-native-context-menu'
  payload: { menu: [] }
} extends MenuProviderIPCAPI ? false : true

const directoryWithoutPayloadRejected: DirectoryWithoutPayloadRejected = true
const directoryWithoutPathRejected: DirectoryWithoutPathRejected = true
const fileWithoutPayloadRejected: FileWithoutPayloadRejected = true
const duplicateWithoutWindowRejected: DuplicateWithoutWindowRejected = true
const syncCitationCannotInvoke: SyncCitationCannotInvoke = true
const syncLRTCannotInvoke: SyncLRTCannotInvoke = true
const dictionaryPayloadMustBeStrings: DictionaryPayloadMustBeStrings = true
const dictionaryPayloadRejectsNumbers: DictionaryPayloadRejectsNumbers = true
const contextMenuPayloadRequiresCoordinates: ContextMenuPayloadRequiresCoordinates = true
const contextMenuPayloadRejectsMissingCoordinates: ContextMenuPayloadRejectsMissingCoordinates = true

describe('IPC type contracts', function () {
  it('admits a bare no-argument command and rejects an arbitrary payload', function () {
    assert.strictEqual(bareCommandAccepted, true)
    assert.strictEqual(arbitraryPayloadRejected, true)
  })

  it('requires the source file path when opening a citation attachment', function () {
    assert.strictEqual(completeOpenAttachmentAccepted, true)
    assert.strictEqual(missingAttachmentFilePathRejected, true)
  })

  it('rejects payloads that the command handlers cannot consume', function () {
    assert.strictEqual(directoryWithoutPayloadRejected, true)
    assert.strictEqual(directoryWithoutPathRejected, true)
    assert.strictEqual(fileWithoutPayloadRejected, true)
    assert.strictEqual(duplicateWithoutWindowRejected, true)
  })

  it('keeps synchronous-only IPC commands out of the invoke contract', function () {
    assert.strictEqual(syncCitationCannotInvoke, true)
    assert.strictEqual(syncLRTCannotInvoke, true)
  })

  it('rejects concrete provider payload mistakes at compile time', function () {
    assert.strictEqual(dictionaryPayloadMustBeStrings, true)
    assert.strictEqual(dictionaryPayloadRejectsNumbers, true)
    assert.strictEqual(contextMenuPayloadRequiresCoordinates, true)
    assert.strictEqual(contextMenuPayloadRejectsMissingCoordinates, true)
  })
})

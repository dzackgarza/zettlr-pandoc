/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Review-diff save gate provider specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real DocumentManager save boundary for issue
 *                  #34: unresolved review chunks and external disk drift both
 *                  refuse writes, preserving the existing on-disk text.
 *
 * END HEADER
 */

import { ipcMainHandlers } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { ChangeSet, Text } from '@codemirror/state'
import { createTwoFilesPatch } from 'diff'
import DocumentManager from 'source/app/service-providers/documents'
import LogProvider from 'source/app/service-providers/log'
import { buildReviewDiffSession } from 'source/app/util/review-diff'
import ReviewDiffAPIProvider, { sendReviewDiffApiRequest } from 'source/app/service-providers/review-diff-api'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type { CodeFileDescriptor } from '@dts/common/fsal'
import type { ReviewDiffDocumentSnapshot, ReviewDiffOpenResult, ReviewDiffSession } from '@dts/common/review-diff'

type IpcHandler = (event: unknown, message: { command: string, payload?: unknown }) => Promise<unknown>|unknown

describe('review-diff save gate', function () {
  let scratch: string
  let provider: DocumentManager
  let apiProvider: ReviewDiffAPIProvider
  let apiSocketPath: string

  function descriptorFor (filePath: string): CodeFileDescriptor {
    const stat = statSync(filePath)
    return {
      path: filePath,
      dir: path.dirname(filePath),
      name: path.basename(filePath),
      ext: path.extname(filePath),
      type: 'code',
      size: stat.size,
      modtime: stat.mtimeMs,
      creationtime: stat.birthtimeMs,
      bom: '',
      linefeed: '\n'
    }
  }

  function normalizedRead (filePath: string): string {
    return readFileSync(filePath, 'utf8').split(/\r\n|\n\r|\n|\r/g).join('\n')
  }

  async function createProvider (): Promise<DocumentManager> {
    const userData = path.join(os.tmpdir(), 'zettlr-pandoc-headless-test')
    mkdirSync(userData, { recursive: true })
    mkdirSync(path.join(userData, 'logs'), { recursive: true })
    rmSync(path.join(userData, 'documents.yaml'), { force: true })

    const watcherSeam = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_path: string) => {},
      unwatchPath: (_path: string) => {},
      shutdown: async () => {}
    }
    let activeWindowId = ''
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: {
            openFiles: [],
            openWorkspaces: [scratch],
            appLang: 'en-US'
          },
          system: {
            avoidNewTabs: false
          },
          editor: {
            autoSave: 'off'
          }
        }),
        addPath: (_path: string) => false,
        set: (_key: string, _value: unknown) => {}
      },
      fsal: {
        getWatchdog: () => watcherSeam,
        testAccess: async () => true,
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => normalizedRead(filePath),
        writeTextFile: async (filePath: string, content: string) => { writeFileSync(filePath, content, 'utf8') },
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath)
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {}
      },
      recentDocs: {
        add: (_path: string) => {}
      },
      windows: {
        showAnyWindow: () => {},
        getFirstMainWindow: () => ({}),
        getMainWindowKey: (_window: unknown) => activeWindowId
      }
    }

    const manager = new DocumentManager(appSeam as unknown as AppServiceContainer)
    await manager.boot()
    activeWindowId = manager.windowKeys()[0]
    return manager
  }

  function documentsProviderHandler (): IpcHandler {
    const registered = ipcMainHandlers.get('documents-provider') as IpcHandler|undefined
    assert.ok(registered !== undefined, 'constructing DocumentManager must register the documents-provider handler')
    return registered
  }

  function documentsAuthorityHandler (): IpcHandler {
    const registered = ipcMainHandlers.get('documents-authority') as IpcHandler|undefined
    assert.ok(registered !== undefined, 'constructing DocumentManager must register the documents-authority handler')
    return registered
  }

  async function pushTextUpdate (filePath: string, fromContent: string, toContent: string, version = 0): Promise<void> {
    const baselineDoc = Text.of(fromContent.split('\n'))
    const changes = ChangeSet.of([
      {
        from: 0,
        to: baselineDoc.length,
        insert: toContent
      }
    ], baselineDoc.length)

    const accepted = await documentsAuthorityHandler()(undefined, {
      command: 'push-updates',
      payload: {
        filePath,
        version,
        updates: [
          {
            changes: changes.toJSON(),
            clientID: 'review-diff-save-gate'
          }
        ]
      }
    })
    assert.equal(accepted, true, 'the provider must accept the real CodeMirror change update')
  }

  async function currentDocumentVersion (filePath: string): Promise<number> {
    const document = await provider.getDocument(filePath)
    return document.startVersion
  }

  async function reportReviewStatus (
    session: ReviewDiffSession,
    unresolvedChunks: number,
    originalText: string,
    currentText: string
  ): Promise<unknown> {
    return await documentsProviderHandler()(undefined, {
      command: 'set-review-diff-status',
      payload: {
        path: session.documentPath,
        sessionId: session.id,
        unresolvedChunks,
        originalText,
        currentText,
        documentVersion: await currentDocumentVersion(session.documentPath),
        sourceWindowId: 'window-a',
        sourceLeafId: 'leaf-a'
      }
    })
  }

  async function openReview (filePath: string, baseline: string, proposed: string): Promise<void> {
    const patchPath = path.join(scratch, 'review.diff')
    writeFileSync(patchPath, createTwoFilesPatch(filePath, filePath, baseline, proposed), 'utf8')
    await provider.getDocument(filePath)
    const session = buildReviewDiffSession({ documentPath: filePath, patchPath })
    assert.equal(await provider.openReviewDiffSession(session), true)
    await pushTextUpdate(filePath, baseline, proposed)
    assert.equal(await reportReviewStatus(session, 0, proposed, proposed), true)
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'zettlr-review-save-gate-'))
    provider = await createProvider()
    apiSocketPath = path.join(scratch, 'review-diff-api.sock')
    apiProvider = new ReviewDiffAPIProvider(new LogProvider(), provider, apiSocketPath)
    await apiProvider.boot()
  })

  afterEach(async function () {
    await apiProvider.shutdown()
    await provider.shutdown()
    rmSync(scratch, { recursive: true, force: true })
  })

  it('refuses saving while review chunks remain unresolved', async function () {
    const baseline = 'alpha\nbeta\n'
    const proposed = 'alpha\nBETA\n'
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')
    const patchPath = path.join(scratch, 'review.diff')
    writeFileSync(patchPath, createTwoFilesPatch(filePath, filePath, baseline, proposed), 'utf8')

    await provider.getDocument(filePath)
    const session = buildReviewDiffSession({ documentPath: filePath, patchPath })
    assert.equal(await provider.openReviewDiffSession(session), true)
    await pushTextUpdate(filePath, baseline, proposed)

    assert.equal(await provider.saveFile(filePath), false)
    assert.equal(readFileSync(filePath, 'utf8'), baseline)
  })

  it('saves the exact mixed accept/reject result after every chunk is resolved', async function () {
    const baseline = [
      'alpha baseline',
      '',
      'middle',
      '',
      'omega baseline',
      ''
    ].join('\n')
    const proposed = baseline
      .replace('alpha baseline', 'alpha proposed')
      .replace('omega baseline', 'omega proposed')
    const mixed = baseline.replace('alpha baseline', 'alpha proposed')
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')
    const patchPath = path.join(scratch, 'review.diff')
    writeFileSync(patchPath, createTwoFilesPatch(filePath, filePath, baseline, proposed), 'utf8')

    await provider.getDocument(filePath)
    const session = buildReviewDiffSession({ documentPath: filePath, patchPath })
    assert.equal(await provider.openReviewDiffSession(session), true)
    await pushTextUpdate(filePath, baseline, mixed)
    assert.equal(await reportReviewStatus(session, 0, mixed, mixed), true)

    assert.equal(await provider.saveFile(filePath), true)
    assert.equal(readFileSync(filePath, 'utf8'), mixed)
  })

  it('preserves the evolving merge original for editor remounts after a partial decision', async function () {
    const baseline = [
      'alpha baseline',
      '',
      'middle',
      '',
      'omega baseline',
      ''
    ].join('\n')
    const proposed = baseline
      .replace('alpha baseline', 'alpha proposed')
      .replace('omega baseline', 'omega proposed')
    const acceptedOriginal = baseline.replace('alpha baseline', 'alpha proposed')
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')
    const patchPath = path.join(scratch, 'review.diff')
    writeFileSync(patchPath, createTwoFilesPatch(filePath, filePath, baseline, proposed), 'utf8')

    await provider.getDocument(filePath)
    const session = buildReviewDiffSession({ documentPath: filePath, patchPath })
    assert.equal(await provider.openReviewDiffSession(session), true)
    await pushTextUpdate(filePath, baseline, proposed)
    assert.equal(await reportReviewStatus(session, 1, acceptedOriginal, proposed), true)

    const remountedSession = await documentsProviderHandler()(undefined, {
      command: 'get-review-diff-session',
      payload: { path: filePath }
    }) as ReviewDiffSession

    assert.equal(remountedSession.originalText, acceptedOriginal)
    assert.equal(remountedSession.currentText, proposed)
    assert.equal(remountedSession.baselineText, baseline)
  })

  it('rejects stale pane completion reports instead of unlocking save', async function () {
    const baseline = 'alpha\nbeta\n'
    const proposed = 'alpha\nBETA\n'
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')
    const patchPath = path.join(scratch, 'review.diff')
    writeFileSync(patchPath, createTwoFilesPatch(filePath, filePath, baseline, proposed), 'utf8')

    await provider.getDocument(filePath)
    const session = buildReviewDiffSession({ documentPath: filePath, patchPath })
    assert.equal(await provider.openReviewDiffSession(session), true)
    await pushTextUpdate(filePath, baseline, proposed)

    const accepted = await documentsProviderHandler()(undefined, {
      command: 'set-review-diff-status',
      payload: {
        path: filePath,
        sessionId: session.id,
        unresolvedChunks: 0,
        originalText: baseline,
        currentText: baseline,
        documentVersion: 0,
        sourceWindowId: 'window-b',
        sourceLeafId: 'leaf-b'
      }
    })

    assert.equal(accepted, false)
    assert.equal(await provider.saveFile(filePath), false)
    assert.equal(readFileSync(filePath, 'utf8'), baseline)
  })

  it('opens review from a versioned live dirty snapshot and rejects stale submissions', async function () {
    const baseline = 'alpha\nbeta\n'
    const dirty = 'alpha dirty\nbeta\n'
    const newerDirty = 'alpha newer\nbeta\n'
    const proposed = 'alpha dirty\nBETA\n'
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')

    await provider.getDocument(filePath)
    await pushTextUpdate(filePath, baseline, dirty)
    const staleSnapshot = await provider.readReviewDiffDocumentSnapshot(filePath)
    assert.equal(staleSnapshot.dirty, true)
    assert.equal(staleSnapshot.content, dirty)

    await pushTextUpdate(filePath, dirty, newerDirty, staleSnapshot.documentVersion)
    const staleResult = await provider.openReviewDiffFromSnapshot({
      path: filePath,
      baselineVersion: staleSnapshot.documentVersion,
      baselineSha256: staleSnapshot.contentSha256,
      proposedText: proposed
    })
    assert.deepEqual(staleResult, {
      accepted: false,
      reason: 'stale-baseline',
      message: 'The open document changed after the review baseline was read.'
    })

    const freshSnapshot = await provider.readReviewDiffDocumentSnapshot(filePath)
    const freshResult = await provider.openReviewDiffFromSnapshot({
      path: filePath,
      baselineVersion: freshSnapshot.documentVersion,
      baselineSha256: freshSnapshot.contentSha256,
      proposedText: newerDirty.replace('beta', 'BETA')
    })
    assert.equal(freshResult.accepted, true)

    const liveSession = await documentsProviderHandler()(undefined, {
      command: 'get-review-diff-session',
      payload: { path: filePath }
    }) as ReviewDiffSession
    assert.equal(liveSession.baselineText, newerDirty)
    assert.equal(liveSession.originalText, newerDirty)
    assert.equal(liveSession.currentText, newerDirty.replace('beta', 'BETA'))
  })

  it('serves live snapshot and review submission over the local request response socket', async function () {
    const baseline = 'alpha\nbeta\n'
    const dirty = 'alpha dirty\nbeta\n'
    const proposed = 'alpha dirty\nBETA\n'
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')

    await provider.getDocument(filePath)
    await pushTextUpdate(filePath, baseline, dirty)

    const readResponse = await sendReviewDiffApiRequest(apiSocketPath, {
      id: 'read-open-buffer',
      method: 'readDocument',
      params: { path: filePath }
    })
    assert.equal(readResponse.ok, true)
    assert.equal(readResponse.id, 'read-open-buffer')
    const snapshot = (readResponse as { ok: true, result: ReviewDiffDocumentSnapshot }).result
    assert.equal(snapshot.content, dirty)
    assert.equal(snapshot.dirty, true)

    const openResponse = await sendReviewDiffApiRequest(apiSocketPath, {
      id: 'open-review',
      method: 'openReview',
      params: {
        path: filePath,
        baselineVersion: snapshot.documentVersion,
        baselineSha256: snapshot.contentSha256,
        proposedText: proposed
      }
    })
    assert.equal(openResponse.ok, true)
    assert.equal(openResponse.id, 'open-review')
    const openResult = (openResponse as { ok: true, result: ReviewDiffOpenResult }).result
    assert.equal(openResult.accepted, true)
  })

  it('refuses saving after external disk drift and preserves the external edit', async function () {
    const baseline = 'alpha\nbeta\n'
    const proposed = 'alpha\nBETA\n'
    const external = 'external edit\n'
    const filePath = path.join(scratch, 'note.tex')
    writeFileSync(filePath, baseline, 'utf8')

    await openReview(filePath, baseline, proposed)
    writeFileSync(filePath, external, 'utf8')

    assert.equal(await provider.saveFile(filePath), false)
    assert.equal(readFileSync(filePath, 'utf8'), external)
  })
})

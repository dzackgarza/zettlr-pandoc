/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: review persistence failure, end to end
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: Every review mutation is written through its sidecar before it
 *              becomes state, so an acknowledged mutation is one already on
 *              disk. This spec breaks that write for real — the sidecar
 *              directory loses its write permission, so the running app meets
 *              exactly the EACCES a full or read-only disk would give it —
 *              and drives each of the five writers through it: a proposal, a
 *              chunk decision, an outstanding-review save, ordinary editor
 *              typing, and the detach a close performs.
 *
 *              What each one owes is the same: report the failure, claim
 *              nothing, destroy nothing, leave the previous sidecar valid, and
 *              work on the retry once the disk does. None of that is
 *              observable below the assembled app, because the failure has to
 *              travel from a filesystem in main to a control or a toast in the
 *              renderer.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import type { ChildProcess } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createPatch } from 'diff'
import type { Browser, Page } from 'playwright'
import {
  agentClient,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  readAgentApiPort,
  requireInitialized,
  shutdown,
  type AgentClient
} from './support/electron-app'

const BASELINE = [
  '# Persistence', '',
  'alpha original', '',
  'bravo original', '',
  'tail line', ''
].join('\n')

/**
 * The real injection: the sidecar directory keeps its contents readable and
 * loses write permission, so `write-file-atomic`'s temporary file fails with
 * EACCES inside the running application. Nothing is stubbed, patched or
 * simulated — this is the same error a read-only or exhausted disk produces,
 * reaching the same code by the same route.
 *
 * Every scenario below asserts that the operation it broke actually failed,
 * so an environment that ignores directory permissions (running as root) is
 * reported as a failure rather than passing silently.
 */
async function breakSidecarWrites (directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await chmod(directory, 0o500)
}

async function allowSidecarWrites (directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await chmod(directory, 0o700)
}

/**
 * Every persisted sidecar, as bytes. "The previous sidecar remains valid" is
 * a claim about the file, so it is compared as the file — a field at a time
 * is what lets an unasserted field move unnoticed.
 */
async function sidecarBytes (directory: string): Promise<Record<string, string>> {
  const names = await readdir(directory)
  const entries = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      .map(async name => [name, await readFile(path.join(directory, name), 'utf8')] as const)
  )
  return Object.fromEntries(entries)
}

function patch (filePath: string, from: string, to: string): string {
  return createPatch(filePath, from, to, '', '', { context: 0 })
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField (payload: unknown, field: string): string {
  assert.ok(isRecord(payload), `expected an object carrying ${field}`)
  assert.equal(typeof payload[field], 'string', `${field} is missing: ${JSON.stringify(payload)}`)
  return payload[field] as string
}

async function openDocumentIds (api: AgentClient): Promise<string[]> {
  const payload = await api.get('/v1/documents')
  assert.ok(isRecord(payload) && Array.isArray(payload.documents))
  return payload.documents.map(document => stringField(document, 'documentId'))
}

async function openDocumentId (api: AgentClient): Promise<string> {
  const ids = await openDocumentIds(api)
  assert.equal(ids.length, 1, `exactly the fixture document must be open: ${JSON.stringify(ids)}`)
  return ids[0]
}

async function workingText (api: AgentClient): Promise<string> {
  const payload = await api.get(
    `/v1/documents/${await openDocumentId(api)}/content?side=working`
  )
  return stringField(payload, 'content')
}

interface ChunkView {
  chunkId: string
  referenceText: string
  workingText: string
  state: string
}

/** The chunk partition, with the fence values a decision has to bind to. */
async function chunkListing (
  api: AgentClient,
  reviewId: string
): Promise<{ chunks: ChunkView[], generation: number, workingSha256: string }> {
  const payload = await api.get(`/v1/reviews/${reviewId}/chunks`)
  assert.ok(
    isRecord(payload) &&
      Array.isArray(payload.chunks) &&
      typeof payload.generation === 'number',
    `chunk listing must carry chunks and a generation: ${JSON.stringify(payload)}`
  )
  return {
    chunks: payload.chunks as ChunkView[],
    generation: payload.generation,
    workingSha256: stringField(payload, 'workingSha256')
  }
}

/** The review's own summary: what "no in-memory destruction" is checked against. */
async function reviewSummary (api: AgentClient, reviewId: string): Promise<string> {
  return JSON.stringify(await api.get(`/v1/reviews/${reviewId}`))
}

async function proposalPreconditions (
  api: AgentClient,
  documentId: string
): Promise<{ baselineSha256: string, expectedReviewGeneration: number }> {
  const payload = await api.get(`/v1/documents/${documentId}/content?side=working`)
  assert.ok(isRecord(payload) && isRecord(payload.revision))
  assert.equal(typeof payload.reviewGeneration, 'number')
  return {
    baselineSha256: stringField(payload.revision, 'sha256'),
    expectedReviewGeneration: payload.reviewGeneration as number
  }
}

/**
 * Closes the document the way the user's own close does: one leaf, one file.
 * `close-file-everywhere` is the watcher's unlink path and tears the tabs down
 * before it detaches, so it cannot answer what a refused close leaves behind.
 */
async function closeFileInPane (page: Page, filePath: string): Promise<unknown> {
  return await page.evaluate(async (pathInPage: string) => {
    const windowId = new URLSearchParams(location.search).get('window_id')
    if (windowId === null) {
      throw new Error('The main window carries no window_id')
    }
    const tree = await window.ipc.invoke('documents-provider', {
      command: 'retrieve-tab-config',
      payload: { windowId }
    })
    if (tree.type !== 'leaf') {
      throw new Error(`Expected a single leaf, got ${tree.type}`)
    }
    return await window.ipc.invoke('documents-provider', {
      command: 'close-file',
      payload: { windowId, leafId: tree.id, path: pathInPage }
    })
  }, filePath)
}

/** Every toast currently on screen, as its message text. */
async function toastMessages (page: Page): Promise<string[]> {
  return await page
    .locator('#zettlr-toast-container .zettlr-toast span:first-child')
    .allInnerTexts()
}

/**
 * Waits for a renderer console error matching `pattern`. The renderer logs the
 * rejected authority push there and nowhere else, so this is how the spec
 * knows the push was attempted and refused rather than merely slow.
 */
async function waitForRendererError (
  events: string[],
  pattern: RegExp,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events.some(event => pattern.test(event))) {
      return
    }
    await delay(100)
  }
  throw new Error(
    `No renderer error matched ${String(pattern)} within ${timeoutMs}ms:\n${events.join('\n')}`
  )
}

/** Waits until the provider's working text satisfies `holds`. */
async function waitForWorkingText (
  api: AgentClient,
  holds: (text: string) => boolean,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await workingText(api)
    if (holds(last)) {
      return last
    }
    await delay(100)
  }
  throw new Error(`The authority never held the expected text. It holds:\n${last}`)
}

describe('a review that cannot be persisted', function () {
  // One cold `forge start` compile plus the five failure scenarios.
  this.timeout(300_000)

  let fixtureRoot: string | undefined
  let sidecarDirectory: string | undefined
  let documentPath: string | undefined
  let browser: Browser | undefined
  let appProcess: ChildProcess | undefined
  let api: AgentClient | undefined
  let page: Page | undefined
  let reviewId: string | undefined
  const rendererEvents: string[] = []

  before(async function () {
    const fixture = await createFixture('zettlr-review-persistence-', {
      documentName: 'persistence.md',
      documentContents: BASELINE,
      config: { agentApi: { enabled: true, port: 0 } }
    })
    fixtureRoot = fixture.root
    documentPath = fixture.documentPath
    sidecarDirectory = path.join(fixture.configDirectory, 'review-sidecars')
    const running = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    api = agentClient(await readAgentApiPort(fixture.configDirectory, 60_000))
    page = await findEditorPage(running.browser, this.timeout())
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await hideDevServerOverlay(page)
  })

  after(async function () {
    // The window has to be closable whatever the last scenario left behind.
    if (sidecarDirectory !== undefined) {
      await allowSidecarWrites(sidecarDirectory)
    }
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('refuses a proposal it cannot persist, and opens no review', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activePath = requireInitialized(documentPath, 'the document path must be initialized')
    const directory = requireInitialized(sidecarDirectory, 'the sidecar directory must be known')

    const documentId = await openDocumentId(activeApi)
    const claims = [
      {
        description: 'Revise alpha',
        patch: patch(activePath, BASELINE, BASELINE.replace('alpha original', 'alpha proposed'))
      }
    ]

    await breakSidecarWrites(directory)
    const refused = await activeApi.postExpectingFailure(
      `/v1/documents/${documentId}/proposals`,
      {
        ...(await proposalPreconditions(activeApi, documentId)),
        clientRequestId: 'persistence-proposal-refused',
        claims
      }
    )
    assert.equal(refused.status, 500, `the proposal must be refused: ${JSON.stringify(refused)}`)
    assert.ok(isRecord(refused.body) && isRecord(refused.body.error))
    assert.equal(refused.body.error.code, 'PERSISTENCE_FAILED')

    // Nothing was opened, and nothing was written.
    const reviews = await activeApi.get('/v1/reviews')
    assert.ok(isRecord(reviews) && Array.isArray(reviews.reviews))
    assert.deepEqual(reviews.reviews, [], 'a refused proposal must open no review')
    assert.deepEqual(await sidecarBytes(directory), {})
    assert.equal(
      await activePage.locator('.cm-reviewStatusPanel').count(),
      0,
      'a refused proposal must not mount review controls'
    )
    assert.equal(await workingText(activeApi), BASELINE)

    await allowSidecarWrites(directory)
    reviewId = stringField(
      await activeApi.post(`/v1/documents/${documentId}/proposals`, {
        ...(await proposalPreconditions(activeApi, documentId)),
        clientRequestId: 'persistence-proposal-retried',
        claims
      }),
      'reviewId'
    )
    await activePage
      .locator('button.cm-review-diff-control.accept')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
    assert.deepEqual(
      Object.keys(await sidecarBytes(directory)).length,
      1,
      'the retried proposal must leave exactly one sidecar'
    )
  })

  it('refuses a chunk decision it cannot persist, and hands the controls back', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const directory = requireInitialized(sidecarDirectory, 'the sidecar directory must be known')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const before = await reviewSummary(activeApi, activeReviewId)
    const beforeSidecars = await sidecarBytes(directory)
    // The controls strip names its chunk by the claim description.
    const widget = activePage.locator('.cm-chunkControls').filter({ hasText: 'Revise alpha' })
    const accept = widget.locator('button.accept')

    await breakSidecarWrites(directory)
    await accept.click()

    const toast = activePage.locator('#zettlr-toast-container .zettlr-toast.error')
    await toast.first().waitFor({ state: 'visible', timeout: 30_000 })
    assert.match(
      await toast.first().locator('span').first().innerText(),
      /^The review could not be persisted, so the mutation was not applied: /,
      'the reviewer must be told the review was not persisted'
    )
    assert.equal(
      (await toastMessages(activePage)).length,
      1,
      'a refused decision raises the refusal and nothing else'
    )
    await widget.waitFor({ state: 'visible', timeout: 5_000 })
    assert.equal(
      await accept.isDisabled(),
      false,
      'a refused decision must hand the controls back so it can be retried'
    )
    assert.equal(await reviewSummary(activeApi, activeReviewId), before)
    assert.deepEqual(await sidecarBytes(directory), beforeSidecars)

    await toast.first().click()
    await allowSidecarWrites(directory)
    await accept.click()
    await widget.waitFor({ state: 'detached', timeout: 30_000 })
    assert.deepEqual(await toastMessages(activePage), [])
    assert.notDeepEqual(
      await sidecarBytes(directory),
      beforeSidecars,
      'the retried decision must reach the sidecar'
    )
  })

  it('refuses an outstanding-review save it cannot persist, and writes no bytes', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activePath = requireInitialized(documentPath, 'the document path must be initialized')
    const directory = requireInitialized(sidecarDirectory, 'the sidecar directory must be known')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    // A second claim, annotated and left outstanding: an outstanding review
    // is the one a save has to write through, because the save is what makes
    // its working text durable.
    const documentId = await openDocumentId(activeApi)
    const current = await workingText(activeApi)
    await activeApi.post(`/v1/documents/${documentId}/proposals`, {
      ...(await proposalPreconditions(activeApi, documentId)),
      clientRequestId: 'persistence-note',
      claims: [
        {
          description: 'Revise bravo',
          patch: patch(activePath, current, current.replace('bravo original', 'bravo proposed'))
        }
      ]
    })
    const noted = activePage.locator('.cm-chunkControls').filter({ hasText: 'Revise bravo' })
    // No submit gesture: the field autosaves after the typing pause, and the
    // saved indicator is the commit's acknowledgment — the sidecar is only
    // broken AFTER this write has landed.
    await noted.locator('input.cm-chunkCommentInput').fill('needs a second look')
    await noted
      .locator('.cm-chunkCommentDirty:not(.unsaved)')
      .waitFor({ state: 'visible', timeout: 30_000 })

    const beforeDisk = await readFile(activePath, 'utf8')
    const beforeReview = await reviewSummary(activeApi, activeReviewId)
    const beforeSidecars = await sidecarBytes(directory)

    await breakSidecarWrites(directory)
    const refused = await activePage.evaluate(
      async (pathInPage: string) =>
        await window.ipc.invoke('documents:save-file', { path: pathInPage }),
      activePath
    )
    assert.ok(
      isRecord(refused) && !refused.ok && isRecord(refused.refusal),
      `the save must refuse with a reason: ${JSON.stringify(refused)}`
    )
    assert.equal(refused.refusal.reason, 'review-not-persisted')
    assert.equal(
      await readFile(activePath, 'utf8'),
      beforeDisk,
      'a refused save must not touch the file'
    )
    assert.equal(await reviewSummary(activeApi, activeReviewId), beforeReview)
    assert.deepEqual(await sidecarBytes(directory), beforeSidecars)
    assert.deepEqual(
      await toastMessages(activePage),
      [],
      'the refusal is the save\'s own answer; nothing may claim success'
    )

    await allowSidecarWrites(directory)
    assert.deepEqual(
      await activePage.evaluate(
        async (pathInPage: string) =>
          await window.ipc.invoke('documents:save-file', { path: pathInPage }),
        activePath
      ),
      { ok: true },
      'the same save must succeed once the sidecar can be written'
    )
    assert.equal(await readFile(activePath, 'utf8'), await workingText(activeApi))
    assert.equal(
      await noted.locator('input.cm-chunkCommentInput').inputValue(),
      'needs a second look',
      'the note stays in its field — its only rendering — after the save'
    )
  })

  it('rejects an editor update it cannot acknowledge, and keeps the authority text', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activePath = requireInitialized(documentPath, 'the document path must be initialized')
    const directory = requireInitialized(sidecarDirectory, 'the sidecar directory must be known')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const beforeText = await workingText(activeApi)
    const beforeReview = await reviewSummary(activeApi, activeReviewId)
    const beforeSidecars = await sidecarBytes(directory)

    await breakSidecarWrites(directory)
    await activePage.locator('.cm-content').click()
    await activePage.keyboard.press('Control+End')
    await activePage.keyboard.type('refused-edit')
    // The push is refused in main and logged here; waiting for that is what
    // makes the assertions below about an attempt rather than about timing.
    await waitForRendererError(rendererEvents, /Pushing updates failed/, 30_000)

    assert.equal(
      await workingText(activeApi),
      beforeText,
      'an update whose sidecar failed must never become the authority text'
    )
    assert.deepEqual(await sidecarBytes(directory), beforeSidecars)
    assert.equal(await reviewSummary(activeApi, activeReviewId), beforeReview)
    const buffer = await activePage.locator('.cm-content').innerText()
    assert.ok(
      buffer.includes('refused-edit'),
      `the typed text stays in the buffer: a refused push destroys nothing.\n${buffer}`
    )
    assert.equal(
      await activePage.locator('.cm-chunkControls').filter({ hasText: 'Revise bravo' }).count(),
      1,
      'the annotated chunk must still be rendered'
    )

    // Retry on a fresh editor: a rejected push leaves this pane's sync loop
    // holding its in-flight flag, so the unsent edit never goes out again from
    // here. Closing and reopening is also what proves the sidecar written
    // before the failure is still loadable — the review comes back from it.
    await allowSidecarWrites(directory)
    await activePage.evaluate(
      async (pathInPage: string) =>
        await window.ipc.invoke('documents-provider', {
          command: 'close-file-everywhere',
          payload: { path: pathInPage }
        }),
      activePath
    )
    const workspaceFiles = await activeApi.get('/v1/workspace/files')
    assert.ok(isRecord(workspaceFiles) && Array.isArray(workspaceFiles.files))
    const entry = workspaceFiles.files.find(
      file => isRecord(file) && file.path === activePath
    )
    await activeApi.post(`/v1/documents/${stringField(entry, 'documentId')}/focus`, {})
    const reopened = activePage.locator('.cm-chunkControls').filter({ hasText: 'Revise bravo' })
    await reopened
      .locator('input.cm-chunkCommentInput')
      .waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(
      await reopened.locator('input.cm-chunkCommentInput').inputValue(),
      'needs a second look',
      'the reattached review restores the note into its field'
    )

    await activePage.locator('.cm-content').click()
    await activePage.keyboard.press('Control+End')
    await activePage.keyboard.type('accepted-edit')
    await waitForWorkingText(activeApi, text => text.includes('accepted-edit'), 30_000)
    assert.notDeepEqual(
      await sidecarBytes(directory),
      beforeSidecars,
      'the acknowledged update must already be in the sidecar'
    )

    // Typing outside the review's chunks adds one of its own. The reviewer
    // accepts it in the pane — the annotated chunk from earlier keeps its
    // note — so the next scenario starts from a saved document with only
    // that annotated chunk outstanding.
    const pending = await chunkListing(activeApi, activeReviewId)
    const typed = pending.chunks.find(chunk => chunk.workingText.includes('accepted-edit'))
    assert.ok(typed !== undefined, `the typed line must be its own chunk: ${JSON.stringify(pending)}`)
    const typedWidget = activePage.locator('.cm-chunkControls').filter({ hasNotText: 'Revise bravo' })
    await typedWidget.waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(
      await typedWidget.count(),
      1,
      'the typed line must be the only unannotated chunk to click'
    )
    await typedWidget.locator('button.cm-review-diff-control.accept').click()
    await typedWidget.waitFor({ state: 'detached', timeout: 30_000 })
    assert.deepEqual(
      await activePage.evaluate(
        async (pathInPage: string) =>
          await window.ipc.invoke('documents:save-file', { path: pathInPage }),
        activePath
      ),
      { ok: true }
    )
  })

  it('leaves the document open when the close cannot persist its review', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activePath = requireInitialized(documentPath, 'the document path must be initialized')
    const directory = requireInitialized(sidecarDirectory, 'the sidecar directory must be known')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const documentId = await openDocumentId(activeApi)
    const beforeReview = await reviewSummary(activeApi, activeReviewId)
    const beforeSidecars = await sidecarBytes(directory)

    await breakSidecarWrites(directory)
    assert.equal(
      await closeFileInPane(activePage, activePath),
      false,
      'a close whose review cannot be persisted must report that it did not close'
    )

    const toast = activePage.locator('#zettlr-toast-container .zettlr-toast.error')
    await toast.first().waitFor({ state: 'visible', timeout: 30_000 })
    assert.match(
      await toast.first().locator('span').first().innerText(),
      /The review could not be written to its sidecar, so this document was left open: /,
      'the person who asked for the close must be told why it did not happen'
    )
    assert.deepEqual(
      await openDocumentIds(activeApi),
      [documentId],
      'the document stays open when its review could not be detached'
    )
    assert.equal(await reviewSummary(activeApi, activeReviewId), beforeReview)
    assert.deepEqual(await sidecarBytes(directory), beforeSidecars)
    await activePage
      .locator('input.cm-chunkCommentInput')
      .waitFor({ state: 'visible', timeout: 5_000 })

    await toast.first().click()
    await allowSidecarWrites(directory)
    assert.equal(
      await closeFileInPane(activePage, activePath),
      true,
      'the retried close must go through once the sidecar can be written'
    )
    await activePage
      .locator('input.cm-chunkCommentInput')
      .waitFor({ state: 'detached', timeout: 30_000 })
    assert.deepEqual(
      await openDocumentIds(activeApi),
      [],
      'the retried close must actually close the document'
    )
    // Detached, not destroyed: the review is still on disk, which is what
    // reattaches it the next time the file is opened.
    assert.equal(
      Object.keys(await sidecarBytes(directory)).length,
      1,
      'the detached review must survive as its sidecar'
    )
  })
})

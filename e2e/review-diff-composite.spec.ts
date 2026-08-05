/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: review-diff closure contract composite lifecycle
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: Drives the assembled Linux app through the complete review
 *              lifecycle: ordered claims, accept/reject/hold decisions,
 *              ordinary editing, identical and blank-line edits,
 *              persistence/restart, exact save bytes, and disk-drift refusal.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { readFile, writeFile, rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createPatch } from 'diff'
import type { Browser, Locator, Page } from 'playwright'
import {
  attach,
  createFixture,
  findEditorPage,
  reserveFreePort,
  shutdown
} from './support/electron-app'

const BASELINE = [
  '# Composite review', '',
  'alpha baseline', '',
  'same', '',
  'same', '',
  '\\[', 'x = 1', 'y = 2', '\\]', '',
  'tail', ''
].join('\n')

interface AgentClient {
  get: (route: string) => Promise<unknown>
  post: (route: string, body?: unknown) => Promise<unknown>
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField (payload: unknown, field: string): string {
  assert.ok(isRecord(payload), `${field} response must be an object`)
  assert.equal(typeof payload[field], 'string', `${field} response is missing a string field`)
  return payload[field] as string
}

function client (port: number): AgentClient {
  const base = `http://127.0.0.1:${port}`
  const request = async (route: string, options?: RequestInit): Promise<unknown> => {
    const response = await fetch(`${base}${route}`, options)
    const text = await response.text()
    const body = text === '' ? undefined : JSON.parse(text)
    if (!response.ok) {throw new Error(`Agent API ${response.status}: ${text}`)}
    return body
  }
  return {
    get: async route => await request(route),
    post: async (route, body) => await request(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    })
  }
}

function patch (filePath: string, from: string, to: string): string {
  return createPatch(filePath, from, to, '', '', { context: 0 })
}

function documentIdOf (payload: unknown): string {
  assert.ok(isRecord(payload) && 'documents' in payload)
  const documents = payload.documents
  assert.ok(Array.isArray(documents))
  assert.equal(documents.length, 1, `unexpected open documents: ${JSON.stringify(payload)}`)
  const document = documents[0]
  assert.ok(isRecord(document) && 'documentId' in document)
  return stringField(document, 'documentId')
}

function documentIdFromSummary (payload: unknown): string {
  return stringField(payload, 'documentId')
}

async function invokeSave (page: Page, filePath: string): Promise<unknown> {
  return await page.evaluate(async pathInPage => await window.ipc.invoke('documents-provider', {
    command: 'save-file',
    payload: { path: pathInPage }
  }), filePath)
}

async function waitForReview (page: Page): Promise<void> {
  await page.locator('.cm-reviewStatusPanel').waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.cm-review-diff-control.accept').first().waitFor({ state: 'visible', timeout: 30_000 })
}

async function widgetWithText (page: Page, text: string): Promise<Locator> {
  const widget = page.locator('.cm-deletedChunk').filter({ hasText: text }).first()
  await widget.waitFor({ state: 'visible', timeout: 20_000 })
  return widget
}

/**
 * The proposal preconditions, read from the working side: the content hash the
 * patches apply to, and the generation of whatever review is open (none = 0).
 */
async function readPreconditions (
  api: AgentClient,
  documentId: string
): Promise<{ baselineSha256: string, expectedReviewGeneration: number }> {
  const payload = await api.get(`/v1/documents/${documentId}/content?side=working`)
  assert.ok(isRecord(payload), 'content response must be an object')
  const { revision, reviewGeneration } = payload as {
    revision?: { sha256?: unknown }
    reviewGeneration?: unknown
  }
  assert.equal(
    typeof revision?.sha256,
    'string',
    `content response carried no revision sha256: ${JSON.stringify(payload)}`
  )
  return {
    baselineSha256: revision?.sha256 as string,
    expectedReviewGeneration: typeof reviewGeneration === 'number' ? reviewGeneration : 0
  }
}

async function submitBatch (api: AgentClient, filePath: string, claims: Array<{ description: string, patch: string }>): Promise<string> {
  const documentId = documentIdOf(await api.get('/v1/documents'))
  const result = await api.post(`/v1/documents/${documentId}/proposals`, {
    ...(await readPreconditions(api, documentId)),
    clientRequestId: 'composite-batch-1',
    claims
  })
  assert.ok(isRecord(result) && 'packetIds' in result && 'reviewId' in result)
  assert.ok(Array.isArray(result.packetIds))
  assert.equal(result.packetIds.length, claims.length)
  return stringField(result, 'reviewId')
}

describe('review-diff closure contract composite lifecycle', function () {
  this.timeout(180_000)

  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let documentPath: string | undefined
  let browser: Browser | undefined
  let appProcess: ChildProcess | undefined

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {await rm(fixtureRoot, { recursive: true, force: true })}
  })

  it('runs batch, mixed UI decisions, held persistence, restart, exact save, and disk-drift refusal', async function () {
    const port = await reserveFreePort()
    const fixture = await createFixture('zettlr-review-diff-composite-', {
      documentName: 'composite.md',
      documentContents: BASELINE,
      config: { agentApi: { enabled: true, port } }
    })
    fixtureRoot = fixture.root
    configDirectory = fixture.configDirectory
    documentPath = fixture.documentPath

    const running = await attach(configDirectory, [], this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    const api = client(port)
    const page = await findEditorPage(browser, this.timeout())

    const step1 = BASELINE.replace('alpha baseline', 'alpha proposal')
    // Two identical occurrences must remain independently actionable: the
    // first is edited and accepted, while the second is rejected.
    const step2 = step1.replace('same\n\nsame', 'DIFF\n\nDIFF')
    const proposed = step2.replace('x = 1', 'x = 7').replace('y = 2', 'y = 8')
    const blankProposed = proposed.replace('tail\n', 'tail\n\n')
    const reviewId = await submitBatch(api, documentPath, [
      { description: 'Revise alpha wording', patch: patch(documentPath, BASELINE, step1) },
      { description: 'Change both repeated occurrences', patch: patch(documentPath, step1, step2) },
      { description: 'Rewrite the display-math environment', patch: patch(documentPath, step2, proposed) },
      { description: 'Preserve the intentional blank line', patch: patch(documentPath, proposed, blankProposed) }
    ])
    await waitForReview(page)
    // One claim can yield two independently actionable chunks when it edits
    // two identical occurrences; every packet still retains its description.
    assert.equal(await page.locator('.cm-chunkDescription').count(), 5)

    // Accept alpha through its real widget.
    await (await widgetWithText(page, 'alpha baseline')).locator('button.accept').click()
    await page.locator('.cm-deletedChunk').filter({ hasText: 'alpha baseline' }).waitFor({ state: 'detached' })

    // Edit the repeated proposal in the ordinary editor, then accept the
    // edited proposal: the provider must accept the bytes now displayed.
    const repeatedWidgets = page.locator('.cm-deletedChunk').filter({ hasText: 'same' })
    await repeatedWidgets.nth(1).waitFor({ state: 'visible' })
    const diffLine = page.locator('.cm-line').filter({ hasText: 'DIFF' }).first()
    await diffLine.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.type('DIFF edited')
    await repeatedWidgets.nth(0).locator('button.accept').click()
    await page.locator('.cm-content').filter({ hasText: 'DIFF edited' }).waitFor({ state: 'visible' })
    await repeatedWidgets.nth(1).waitFor({ state: 'detached' })

    // Reject the second identical occurrence independently of the first.
    const rejectedRepeated = repeatedWidgets.nth(0)
    await rejectedRepeated.locator('button.reject').click()
    await rejectedRepeated.waitFor({ state: 'detached' })

    // Hold the display-math chunk with a comment and add a review-level note.
    const math = await widgetWithText(page, 'x = 1')
    const holdInput = math.locator('input.cm-holdCommentInput')
    await holdInput.fill('check the constants')
    await math.locator('button.hold').click()
    await page.locator('.cm-deletedChunk.held').filter({ hasText: 'x = 1' }).waitFor({ state: 'visible' })
    await page.locator('.cm-reviewCommentInput').fill('overall composite note')
    await page.locator('.cm-reviewCommentSubmit').click()
    await page.locator('.cm-reviewComment').filter({ hasText: 'overall composite note' }).waitFor({ state: 'visible' })

    // Resolve the blank-line-only chunk by its empty reference/working text.
    const blankChunks = await api.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(isRecord(blankChunks) && Array.isArray(blankChunks.chunks))
    const blankChunk = blankChunks.chunks.find(chunk =>
      isRecord(chunk) && chunk.referenceText === '' && chunk.workingText === '')
    assert.ok(isRecord(blankChunk), 'blank-line-only proposal must remain actionable')
    const blankChunkId = stringField(blankChunk, 'chunkId')
    await api.post(`/v1/reviews/${reviewId}/chunks/${blankChunkId}/accept`)

    const heldSave = await invokeSave(page, documentPath)
    assert.deepEqual(heldSave, { ok: true })
    const mixedExpected = blankProposed.replace('DIFF\n\nDIFF', 'DIFF edited\n\nsame')
    assert.equal(await readFile(documentPath, 'utf8'), mixedExpected)

    // Close and reopen in the same running app: sidecar state must reattach.
    await page.evaluate(async pathInPage => await window.ipc.invoke('documents-provider', {
      command: 'close-file-everywhere', payload: { path: pathInPage }
    }), documentPath)
    const reopenedId = documentIdFromSummary(await api.post('/v1/documents', {
      uri: pathToFileURL(documentPath).href
    }))
    await api.post(`/v1/documents/${reopenedId}/focus`)
    await waitForReview(page)
    assert.ok((await page.locator('.cm-deletedChunk.held').innerText()).includes('check the constants'))
    const reopenedReview = await api.get(`/v1/reviews/${reviewId}`)
    assert.ok(isRecord(reopenedReview) && Array.isArray(reopenedReview.comments))
    assert.ok(reopenedReview.comments.some(comment => isRecord(comment) && comment.text === 'overall composite note'))
    const reopenedPackets = await api.get(`/v1/reviews/${reviewId}/packets`)
    assert.ok(isRecord(reopenedPackets) && Array.isArray(reopenedPackets.packets))
    assert.deepEqual(
      reopenedPackets.packets.map(packet => isRecord(packet) ? packet.description : undefined),
      [
        'Revise alpha wording',
        'Change both repeated occurrences',
        'Rewrite the display-math environment',
        'Preserve the intentional blank line'
      ],
      'sidecar reattachment must preserve every packet description and its order'
    )

    // A real process restart must restore the same sidecar-backed review.
    await shutdown(browser, appProcess)
    browser = undefined
    appProcess = undefined
    const restarted = await attach(configDirectory, [], this.timeout())
    browser = restarted.browser
    appProcess = restarted.appProcess
    const restartedPage = await findEditorPage(browser, this.timeout())
    const restartedApi = client(port)
    await waitForReview(restartedPage)
    const outstanding = await restartedApi.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(isRecord(outstanding) && Array.isArray(outstanding.chunks))
    assert.equal(outstanding.chunks.length, 1)
    assert.ok(isRecord(outstanding.chunks[0]))
    assert.equal(outstanding.chunks[0].state, 'held')
    assert.equal(outstanding.chunks[0].holdComment, 'check the constants')
    assert.ok(Array.isArray(outstanding.chunks[0].packetIds) && outstanding.chunks[0].packetIds.length > 0)
    assert.ok(Array.isArray(outstanding.chunks[0].descriptions))
    assert.ok(outstanding.chunks[0].descriptions.includes('Rewrite the display-math environment'))

    // Resolve the held block through the UI and prove exact final bytes.
    await restartedPage.locator('.cm-deletedChunk.held button.accept').click()
    const resolvedSave = await invokeSave(restartedPage, documentPath)
    assert.ok(isRecord(resolvedSave) && resolvedSave.ok === true)
    assert.equal(await readFile(documentPath, 'utf8'), mixedExpected)

    // The ordinary editor's existing clear operation is the mass-reject path:
    // it must be reachable from the real status panel and restore the current
    // review reference before the normal save completes the review.
    const clearProposal = mixedExpected.replace('tail', 'tail clear candidate')
    const clearDocumentId = documentIdOf(await restartedApi.get('/v1/documents'))
    const clearReview = await restartedApi.post(`/v1/documents/${clearDocumentId}/proposals`, {
      ...(await readPreconditions(restartedApi, clearDocumentId)),
      clientRequestId: 'composite-clear',
      claims: [
        {
          description: 'clear remaining review work',
          patch: patch(documentPath, mixedExpected, clearProposal)
        }
      ]
    })
    assert.ok(isRecord(clearReview) && typeof clearReview.reviewId === 'string')
    await waitForReview(restartedPage)
    await restartedPage.locator('button.cm-reviewClear').click()
    await restartedPage.locator('.cm-reviewStatusPanel').waitFor({ state: 'detached', timeout: 30_000 })
    assert.deepEqual(
      await invokeSave(restartedPage, documentPath),
      { ok: true },
      'the clear result must be saveable through the ordinary editor'
    )
    assert.equal(await readFile(documentPath, 'utf8'), mixedExpected)

    // External disk drift is never overwritten by a later review save.
    const finalText = await readFile(documentPath, 'utf8')
    const finalId = documentIdOf(await restartedApi.get('/v1/documents'))
    const driftReview = await restartedApi.post(`/v1/documents/${finalId}/proposals`, {
      ...(await readPreconditions(restartedApi, finalId)),
      clientRequestId: 'composite-drift',
      claims: [
        {
          description: 'drift guard',
          patch: patch(documentPath, finalText, finalText.replace('tail', 'tail externally proposed'))
        }
      ]
    })
    await writeFile(documentPath, finalText.replace('tail', 'external disk edit'), 'utf8')
    const refused = await invokeSave(restartedPage, documentPath)
    assert.ok(isRecord(refused) && refused.ok === false)
    assert.equal((await readFile(documentPath, 'utf8')).includes('external disk edit'), true)
    const driftReviewId = stringField(driftReview, 'reviewId')
    const driftChunks = await restartedApi.get(`/v1/reviews/${driftReviewId}/chunks`)
    assert.ok(isRecord(driftChunks) && Array.isArray(driftChunks.chunks) && driftChunks.chunks.length > 0)
    assert.ok(isRecord(driftChunks.chunks[0]))
    const driftChunkId = stringField(driftChunks.chunks[0], 'chunkId')
    const refusedDecision = await restartedPage.evaluate(async ({ reviewId, chunkId }) => {
      return await window.ipc.invoke('documents-provider', {
        command: 'decide-review-chunk',
        payload: { reviewId, chunkId, decision: 'reject' }
      })
    }, { reviewId: driftReviewId, chunkId: driftChunkId })
    assert.ok(isRecord(refusedDecision) && !refusedDecision.ok)
    assert.equal(refusedDecision.code, 'REVIEW_INVALIDATED')
    const invalidated = await restartedApi.get(`/v1/reviews/${driftReviewId}`)
    assert.ok(isRecord(invalidated))
    assert.equal(invalidated.state, 'invalidated')
  })
})

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
 *              lifecycle: ordered claims, mixed decisions, ordinary editing,
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

async function submitBatch (api: AgentClient, filePath: string, claims: Array<{ description: string, patch: string }>): Promise<string> {
  const documentId = documentIdOf(await api.get('/v1/documents'))
  const snapshot = stringField(
    await api.get(`/v1/documents/${documentId}/content?side=working`),
    'snapshot'
  )
  const result = await api.post(`/v1/documents/${documentId}/proposals`, {
    snapshot,
    patchFormat: 'unified-diff',
    claims,
    clientRequestId: 'composite-batch-1'
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
    const step2 = step1.replace('same\n\nsame', 'same\n\nDIFF')
    const proposed = step2.replace('x = 1', 'x = 7').replace('y = 2', 'y = 8')
    const reviewId = await submitBatch(api, documentPath, [
      { description: 'Revise alpha wording', patch: patch(documentPath, BASELINE, step1) },
      { description: 'Change the second repeated occurrence', patch: patch(documentPath, step1, step2) },
      { description: 'Rewrite the display-math environment', patch: patch(documentPath, step2, proposed) }
    ])
    await waitForReview(page)
    assert.equal(await page.locator('.cm-chunkDescription').count(), 3)

    // Accept alpha through its real widget.
    await (await widgetWithText(page, 'alpha baseline')).locator('button.accept').click()
    await page.locator('.cm-deletedChunk').filter({ hasText: 'alpha baseline' }).waitFor({ state: 'detached' })

    // Edit the repeated proposal in the ordinary editor, then accept the
    // edited proposal: the provider must accept the bytes now displayed.
    const diffLine = page.locator('.cm-line').filter({ hasText: 'DIFF' }).first()
    await diffLine.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.type('DIFF edited')
    const repeated = await widgetWithText(page, 'same')
    await repeated.locator('button.accept').click()
    await page.locator('.cm-content').filter({ hasText: 'DIFF edited' }).waitFor({ state: 'visible' })
    await repeated.waitFor({ state: 'detached' })

    // Hold the display-math chunk with a comment and add a review-level note.
    const math = await widgetWithText(page, 'x = 1')
    const holdInput = math.locator('input.cm-holdCommentInput')
    await holdInput.fill('check the constants')
    await math.locator('button.hold').click()
    await page.locator('.cm-deletedChunk.held').filter({ hasText: 'x = 1' }).waitFor({ state: 'visible' })
    await page.locator('.cm-reviewCommentInput').fill('overall composite note')
    await page.locator('.cm-reviewCommentSubmit').click()
    await page.locator('.cm-reviewComment').filter({ hasText: 'overall composite note' }).waitFor({ state: 'visible' })

    const heldSave = await invokeSave(page, documentPath)
    assert.deepEqual(heldSave, { ok: true })
    assert.equal(await readFile(documentPath, 'utf8'), proposed.replace('DIFF', 'DIFF edited'))

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

    // Resolve the held block through the UI and prove exact final bytes.
    await restartedPage.locator('.cm-deletedChunk.held button.accept').click()
    const resolvedSave = await invokeSave(restartedPage, documentPath)
    assert.ok(isRecord(resolvedSave) && resolvedSave.ok === true)
    assert.equal(await readFile(documentPath, 'utf8'), proposed.replace('DIFF', 'DIFF edited'))

    // External disk drift is never overwritten by a later review save.
    const finalText = await readFile(documentPath, 'utf8')
    const finalId = documentIdOf(await restartedApi.get('/v1/documents'))
    const finalSnapshot = stringField(
      await restartedApi.get(`/v1/documents/${finalId}/content?side=working`),
      'snapshot'
    )
    const driftReview = await restartedApi.post(`/v1/documents/${finalId}/proposals`, {
      snapshot: finalSnapshot,
      patchFormat: 'unified-diff',
      patch: patch(documentPath, finalText, finalText.replace('tail', 'tail externally proposed')),
      description: 'drift guard',
      clientRequestId: 'composite-drift'
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

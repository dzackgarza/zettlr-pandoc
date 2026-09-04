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
 *              lifecycle: ordered claims, accept/reject decisions, chunk
 *              comments, ordinary editing, identical and blank-line edits,
 *              persistence/restart, exact save bytes, and disk-drift refusal.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { readFile, writeFile, rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { createPatch } from 'diff'
import type { Browser, Locator, Page } from 'playwright'
import {
  attach,
  createFixture,
  delay,
  findEditorPage,
  readAgentApiPort,
  shutdown
} from './support/electron-app'

/** The annotations panel: where every review control lives after M9. */
const PANEL = '#annotations-panel'

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

/** The id the workspace listing hands out for a path, open or closed. */
async function workspaceDocumentId (api: AgentClient, filePath: string): Promise<string> {
  const payload = await api.get('/v1/workspace/files')
  assert.ok(isRecord(payload) && Array.isArray(payload.files))
  const entry = payload.files.find(file => isRecord(file) && file.path === filePath)
  assert.ok(isRecord(entry), `workspace listing carried no entry for ${filePath}`)
  return stringField(entry, 'documentId')
}

async function invokeSave (page: Page, filePath: string): Promise<unknown> {
  return page.evaluate(
    async pathInPage => await window.ipc.invoke('documents:save-file', { path: pathInPage }),
    filePath
  )
}

async function waitForReview (page: Page): Promise<void> {
  await page.locator(`${PANEL} .suggestion-inspector`).waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator(`${PANEL} .suggestion-decision.accept`).first().waitFor({ state: 'visible', timeout: 30_000 })
}

/** Every outstanding chunk the panel currently offers a decision on. */
function panelCards (page: Page): Locator {
  return page.locator(`${PANEL} .suggestion-chunk`)
}

async function cardWithText (page: Page, text: string): Promise<Locator> {
  const card = panelCards(page).filter({ hasText: text }).first()
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  return card
}

/** Polls `probe` until `holds` accepts what it answers. */
async function waitUntil<T> (
  probe: () => Promise<T>,
  holds: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await probe()
  while (Date.now() < deadline) {
    if (holds(last)) {
      return last
    }
    await delay(150)
    last = await probe()
  }
  throw new Error(`Timed out waiting for ${what}. Last value: ${JSON.stringify(last)}`)
}

interface ChunkView {
  chunkId: string
  /** The bytes the chunk currently owns on the working side. */
  workingText: string
  descriptions: string[]
  workingSpans: Array<{ from: number, to: number }>
}

/**
 * The provider's outstanding chunks, in document order.
 *
 * Every outstanding chunk owns at least one working span — that is what makes
 * it locatable — so a chunk without one is a provider defect, and the sort
 * asserts rather than substituting a position for it. Ordering an unlocatable
 * chunk as if it sat at offset 0 would silently reorder the list the callers
 * index by position.
 */
async function chunkViews (api: AgentClient, reviewId: string): Promise<ChunkView[]> {
  const payload = await api.get(`/v1/reviews/${reviewId}/chunks`)
  assert.ok(isRecord(payload) && Array.isArray(payload.chunks))
  const chunks = payload.chunks as ChunkView[]
  const startOf = (chunk: ChunkView): number => {
    const span = chunk.workingSpans[0]
    assert.ok(span !== undefined, `chunk ${chunk.chunkId} carries no working span, so it has no document position`)
    return span.from
  }
  return chunks.slice().sort((left, right) => startOf(left) - startOf(right))
}

/** The provider's authoritative working text, as bytes. */
async function workingSide (api: AgentClient, documentId: string): Promise<string> {
  const payload = await api.get(`/v1/documents/${documentId}/content?side=working`)
  return stringField(payload, 'content')
}

/** Every note the provider currently holds against a chunk of this review. */
async function chunkNotes (api: AgentClient, reviewId: string): Promise<string[]> {
  const payload = await api.get(`/v1/reviews/${reviewId}/chunks`)
  assert.ok(isRecord(payload) && Array.isArray(payload.chunks))
  return payload.chunks
    .map(chunk => (isRecord(chunk) ? chunk.comment : undefined))
    .filter((comment): comment is string => typeof comment === 'string')
}

/** Every review-level comment the provider currently holds. */
async function reviewComments (api: AgentClient, reviewId: string): Promise<string[]> {
  const payload = await api.get(`/v1/reviews/${reviewId}`)
  assert.ok(isRecord(payload) && Array.isArray(payload.comments))
  return payload.comments
    .map(comment => (isRecord(comment) ? comment.text : undefined))
    .filter((text): text is string => typeof text === 'string')
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

async function submitBatch (api: AgentClient, claims: Array<{ description: string, patch: string }>): Promise<string> {
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
  // This suite launches the app TWICE (it restarts mid-test to prove sidecar
  // persistence), and every launch pays a full cold webpack compile through
  // `forge start` — a persistent dev cache is not an option because the
  // asset-relocator loader that embeds native modules (nodehun) skips asset
  // emission for cache-restored builds. Two cold compiles under machine load
  // regularly exceeded the old 180 s budget; that flake predates this branch.
  this.timeout(600_000)

  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let documentPath: string | undefined
  let browser: Browser | undefined
  let appProcess: ChildProcess | undefined

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {await rm(fixtureRoot, { recursive: true, force: true })}
  })

  it('runs batch, mixed UI decisions, chunk-note persistence, restart, exact save, and disk-drift refusal', async function () {
    const fixture = await createFixture('zettlr-review-diff-composite-', {
      documentName: 'composite.md',
      documentContents: BASELINE,
      config: {
        agentApi: { enabled: true, port: 0 },
        // Every review control lives in the sidebar's annotations panel (M9),
        // so the fixture opens the sidebar on that tab.
        window: { sidebarVisible: true, currentSidebarTab: 'annotations' }
      }
    })
    fixtureRoot = fixture.root
    configDirectory = fixture.configDirectory
    documentPath = fixture.documentPath

    const running = await attach(configDirectory, [], this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    const api = client(await readAgentApiPort(configDirectory, 60_000))
    const page = await findEditorPage(browser, this.timeout())

    const step1 = BASELINE.replace('alpha baseline', 'alpha proposal')
    // Two identical occurrences must remain independently actionable: the
    // first is edited and accepted, while the second is rejected.
    const step2 = step1.replace('same\n\nsame', 'DIFF\n\nDIFF')
    const proposed = step2.replace('x = 1', 'x = 7').replace('y = 2', 'y = 8')
    const blankProposed = proposed.replace('tail\n', 'tail\n\n')
    const reviewId = await submitBatch(api, [
      { description: 'Revise alpha wording', patch: patch(documentPath, BASELINE, step1) },
      { description: 'Change both repeated occurrences', patch: patch(documentPath, step1, step2) },
      { description: 'Rewrite the display-math environment', patch: patch(documentPath, step2, proposed) },
      { description: 'Preserve the intentional blank line', patch: patch(documentPath, proposed, blankProposed) }
    ])
    await waitForReview(page)
    // One claim can yield two independently actionable chunks when it edits
    // two identical occurrences; every packet still retains its description.
    // Six here: alpha, the two repeated occurrences, the two lines of the
    // display-math rewrite, and the blank line.
    assert.equal(await page.locator(`${PANEL} .suggestion-chunk-description`).count(), 6)

    // Accept alpha through its real card. The card names its chunk by the
    // claim description, not the replaced reference text.
    await (await cardWithText(page, 'Revise alpha wording'))
      .locator('.suggestion-decision.accept')
      .click()
    await panelCards(page).filter({ hasText: 'Revise alpha wording' }).waitFor({ state: 'detached' })

    // Edit the repeated proposal in the ordinary editor, then accept the
    // edited proposal: the provider must accept the bytes now displayed.
    const repeatedCards = panelCards(page).filter({ hasText: 'Change both repeated occurrences' })
    await repeatedCards.nth(1).waitFor({ state: 'visible' })
    // Named by id before the edit: a rewrite re-anchors the chunk, so what it
    // reads afterwards is the provider's answer, not something to predict.
    const repeatedBefore = (await chunkViews(api, reviewId))
      .filter(chunk => chunk.descriptions.includes('Change both repeated occurrences'))
    assert.equal(repeatedBefore.length, 2, 'the repeated claim must be two decidable chunks')
    const editedChunkId = repeatedBefore[0].chunkId

    const diffLine = page.locator('.cm-line').filter({ hasText: 'DIFF' }).first()
    await diffLine.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.type('DIFF edited')
    // Wait for the PANEL to redraw from the edit before clicking. The panel
    // never reads the buffer: it redraws, and forms its fence, only from the
    // authority's broadcast, so a card holding exactly the bytes the provider
    // projected is the proof the edit landed first. A click issued earlier
    // names text the provider has not seen, and is refused for it.
    await waitUntil(
      async () => await workingSide(api, documentIdOf(await api.get('/v1/documents'))),
      text => text.includes('DIFF edited'),
      'the authority to hold the edited line'
    )
    const editedChunk = (await chunkViews(api, reviewId))
      .find(chunk => chunk.chunkId === editedChunkId)
    assert.ok(editedChunk !== undefined, 'the owner rewrite must not destroy the chunk it rewrote')
    const editedCard = page.locator(`${PANEL} .suggestion-chunk[data-chunk-id="${editedChunkId}"]`)
    await waitUntil(
      async () => await editedCard.locator('ins').innerText(),
      value => value === editedChunk.workingText,
      'the panel to redraw the edited card from the authority'
    )
    await editedCard.locator('.suggestion-decision.accept').click()
    await repeatedCards.nth(1).waitFor({ state: 'detached' })

    // Reject the second identical occurrence independently of the first.
    await repeatedCards.first().locator('.suggestion-decision.reject').click()
    await repeatedCards.first().waitFor({ state: 'detached' })

    // Annotate the display-math chunk with a note and add a review-level
    // comment. The note decides nothing: the chunk stays outstanding. Both
    // are fenced mutations like any decision, so the provider answering with
    // them is the only acknowledgment there is — neither renders anywhere
    // else in the panel.
    const math = await cardWithText(page, 'Rewrite the display-math environment')
    const noteInput = math.locator('input.suggestion-chunk-comment')
    await noteInput.fill('check the constants')
    await noteInput.press('Enter')
    await waitUntil(
      async () => await chunkNotes(api, reviewId),
      notes => notes.includes('check the constants'),
      'the chunk note to reach the provider'
    )
    await page.locator(`${PANEL} .suggestion-review-comment-input`).fill('overall composite note')
    await page.locator(`${PANEL} .suggestion-review-comment-submit`).click()
    await waitUntil(
      async () => await reviewComments(api, reviewId),
      comments => comments.includes('overall composite note'),
      'the review comment to reach the provider'
    )

    // The blank-line-only chunk is still undecided too. The API vouches for
    // it by the one character it owns and the nothing it replaced; the
    // reviewer resolves it from its own card, which a chunk that renders no
    // visible text must still draw controls for.
    const blankChunks = await api.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(isRecord(blankChunks) && Array.isArray(blankChunks.chunks))
    const blankChunk = blankChunks.chunks.find(chunk =>
      isRecord(chunk) && chunk.referenceText === '' && chunk.workingText === '\n')
    assert.ok(isRecord(blankChunk), 'blank-line-only proposal must remain actionable')
    const blankCard = panelCards(page).filter({ hasText: 'Preserve the intentional blank line' })
    assert.equal(
      await blankCard.count(),
      1,
      'the blank chunk must render its own card to click'
    )
    await blankCard.locator('.suggestion-decision.accept').click()
    await blankCard.waitFor({ state: 'detached' })

    // The annotated chunk is still outstanding, and the save persists the
    // document as-is with the review — the note included — alongside it.
    const annotatedSave = await invokeSave(page, documentPath)
    assert.deepEqual(annotatedSave, { ok: true })
    const mixedExpected = blankProposed.replace('DIFF\n\nDIFF', 'DIFF edited\n\nsame')
    assert.equal(await readFile(documentPath, 'utf8'), mixedExpected)

    // Close and reopen in the same running app: sidecar state must reattach.
    await page.evaluate(async pathInPage => await window.ipc.invoke('documents-provider', {
      command: 'close-file-everywhere', payload: { path: pathInPage }
    }), documentPath)
    // Focus is now the only operation that deliberately takes a pane, and
    // opening the file is what reattaches its sidecar-backed review.
    await api.post(`/v1/documents/${await workspaceDocumentId(api, documentPath)}/focus`)
    await waitForReview(page)
    assert.equal(
      await (await cardWithText(page, 'Rewrite the display-math environment'))
        .locator('input.suggestion-chunk-comment').inputValue(),
      'check the constants',
      'the reattached review restores the note into its field'
    )
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
    // The restarted instance owns a fresh kernel-assigned port.
    const restartedApi = client(await readAgentApiPort(configDirectory, 60_000))
    await waitForReview(restartedPage)
    const outstanding = await restartedApi.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(isRecord(outstanding) && Array.isArray(outstanding.chunks))
    // The display-math claim rewrote two lines, so it is outstanding as two
    // regions — and the note the reviewer wrote sits on the one they wrote it
    // on, not on the claim as a whole.
    assert.equal(outstanding.chunks.length, 2)
    for (const chunk of outstanding.chunks) {
      assert.ok(isRecord(chunk))
      assert.ok(Array.isArray(chunk.packetIds) && chunk.packetIds.length > 0)
      assert.ok(Array.isArray(chunk.descriptions))
      assert.ok(chunk.descriptions.includes('Rewrite the display-math environment'))
    }
    assert.deepEqual(
      outstanding.chunks.map(chunk => isRecord(chunk) ? chunk.comment : undefined),
      ['check the constants', undefined],
      'the restored note names the region it was written on'
    )

    // Resolve the annotated block through the UI and prove exact final bytes.
    // Each region is its own decision; the last card leaves with the last of
    // them, and the review itself outlives them until the save that closes it.
    const cards = panelCards(restartedPage)
    await cards.first().locator('.suggestion-decision.accept').click()
    await cards.nth(1).waitFor({ state: 'detached', timeout: 30_000 })
    await cards.first().locator('.suggestion-decision.accept').click()
    await cards.first().waitFor({ state: 'detached', timeout: 30_000 })
    const resolvedSave = await invokeSave(restartedPage, documentPath)
    assert.ok(isRecord(resolvedSave) && resolvedSave.ok === true)
    assert.equal(await readFile(documentPath, 'utf8'), mixedExpected)

    // The panel's clear operation is the mass-reject path: it must be
    // reachable from the real inspector and restore the current review
    // reference before the normal save completes the review.
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
    await restartedPage.locator(`${PANEL} .suggestion-clear`).click()
    await panelCards(restartedPage).first().waitFor({ state: 'detached', timeout: 30_000 })
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
    // An invalidated review refuses before any precondition is read, so the
    // fence values here only have to be well formed.
    const refusedDecision = await restartedPage.evaluate(async ({ reviewId, chunkId }) => {
      return await window.ipc.invoke('documents:decide-review-chunk', {
        reviewId,
        chunkId,
        decision: 'reject',
        expectedReviewGeneration: 0,
        expectedWorkingSha256: '0'.repeat(64)
      })
    }, { reviewId: driftReviewId, chunkId: driftChunkId })
    assert.ok(isRecord(refusedDecision) && !refusedDecision.ok)
    assert.equal(refusedDecision.code, 'REVIEW_INVALIDATED')
    const invalidated = await restartedApi.get(`/v1/reviews/${driftReviewId}`)
    assert.ok(isRecord(invalidated))
    assert.equal(invalidated.state, 'invalidated')
  })
})

// Regression proof for the review save-gate deadlock: a proposal submitted over
// the Agent API, every chunk accepted in the pane, and the buffer then refused
// by the save gate forever.
//
// Two defects produced it, and nothing below the assembled app can observe
// either, because both are disagreements between the two processes:
//
//  1. The provider pushed a live ChangeSet into an update history that holds
//     ChangeSet.toJSON() everywhere else. ChangeSet.fromJSON rejected it, the
//     renderer's pull loop died, and the pane's accept report never reached the
//     authority — so the gate saw an unresolved chunk forever.
//  2. Both the provider and the pane applied the initial proposal, and collab
//     rebased the two into two insertions, so a successful save wrote the
//     accepted text twice.
//
// Making `reviewGeneration` required was an earlier fix to the same symptom's
// neighbourhood and did not cure it; the wire format did.
import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Page } from 'playwright'
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  outputTail,
  preserveArtifacts,
  readAppLog,
  requireInitialized,
  shutdown
} from './support/electron-app'

const ORIGINAL_PHRASE = 'A simple normal crossings divisor bounds the fibre.'
const PROPOSED_PHRASE = 'A SNC divisor bounds the fibre.'
const STRICT_PHRASE = 'A strict normal crossings divisor bounds the fibre.'
const SNC_PHRASE = 'An SNC divisor bounds the fibre.'
const DOCUMENT_CONTENTS = `# Review gate\n\n${ORIGINAL_PHRASE}\n`
/** What is on disk once the first test's accepted save has landed. */
const SAVED_CONTENTS = `# Review gate\n\n${PROPOSED_PHRASE}\n`
/** What is on disk once a pending review's save has landed its proposal. */
const PENDING_SAVED_CONTENTS = `# Review gate\n\n${STRICT_PHRASE}\n`
const ARTIFACT_DIRECTORY = path.join(
  tmpdir(),
  'zettlr-review-diff-save-gate-e2e-latest'
)

interface AgentClient {
  get: (route: string) => Promise<unknown>
  post: (route: string, body: unknown) => Promise<unknown>
}

function agentClient (port: number): AgentClient {
  const base = `http://127.0.0.1:${port}`
  const readResponse = async (response: Response): Promise<unknown> => {
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `Agent API ${response.status} for ${response.url}: ${text}`
      )
    }
    return JSON.parse(text)
  }
  return {
    get: async route => await readResponse(await fetch(`${base}${route}`)),
    post: async (route, body) =>
      await readResponse(
        await fetch(`${base}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      )
  }
}

async function waitForAgentApi (
  client: AgentClient,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never attempted'
  while (Date.now() < deadline) {
    try {
      await client.get('/v1/ping')
      return
    } catch (error) {
      lastError = String(error)
      await delay(250)
    }
  }
  throw new Error(
    `The Agent API did not answer /v1/ping within ${timeoutMs}ms. Last error: ${lastError}`
  )
}

/**
 * Narrow the one read field this spec needs. The server is contract-typed and
 * conformance-tested elsewhere; this is the test's own boundary check so a shape
 * change fails here with the payload rather than as `undefined` further down.
 */
function readSha256 (payload: unknown): string {
  assert.ok(
    payload !== null && typeof payload === 'object',
    `Read response was not an object: ${JSON.stringify(payload)}`
  )
  const { revision } = payload as { revision?: { sha256?: unknown } }
  assert.equal(
    typeof revision?.sha256,
    'string',
    `Read response carried no revision sha256: ${JSON.stringify(payload)}`
  )
  return revision?.sha256 as string
}

function reviewIdOf (payload: unknown): string {
  assert.ok(
    payload !== null && typeof payload === 'object' && 'reviewId' in payload &&
      typeof payload.reviewId === 'string',
    `Proposal response carried no reviewId: ${JSON.stringify(payload)}`
  )
  return payload.reviewId
}

function documentIdOf (payload: unknown): string {
  assert.ok(
    payload !== null && typeof payload === 'object' && 'documents' in payload,
    `Document list response had no documents array: ${JSON.stringify(payload)}`
  )
  const { documents } = payload as {
    documents: Array<{ documentId?: unknown }>
  }
  assert.equal(
    documents.length,
    1,
    `Expected exactly the fixture document to be open, got ${JSON.stringify(documents)}`
  )
  const documentId = documents[0].documentId
  assert.equal(
    typeof documentId,
    'string',
    `Open document carried no documentId: ${JSON.stringify(documents[0])}`
  )
  return documentId as string
}

/**
 * The documentId for a path that may currently be closed: /v1/documents lists
 * only open documents, so reopening resolves through the workspace listing.
 */
async function workspaceDocumentId (
  client: AgentClient,
  documentPath: string
): Promise<string> {
  const payload = await client.get('/v1/workspace/files')
  assert.ok(
    payload !== null && typeof payload === 'object' && 'files' in payload &&
      Array.isArray(payload.files),
    `Workspace listing had no files array: ${JSON.stringify(payload)}`
  )
  const entry = (payload.files as Array<{ path?: unknown, documentId?: unknown }>)
    .find(file => file.path === documentPath)
  assert.ok(
    entry !== undefined && typeof entry.documentId === 'string',
    `Workspace listing carried no documentId for ${documentPath}: ${JSON.stringify(payload)}`
  )
  return entry.documentId
}

/** The two review-detail fields the pending-save proofs compare across saves. */
async function reviewCounts (
  client: AgentClient,
  reviewId: string
): Promise<{ unresolvedChunks: number, generation: number }> {
  const detail = await client.get(`/v1/reviews/${reviewId}`)
  assert.ok(
    detail !== null && typeof detail === 'object' &&
      'unresolvedChunks' in detail && typeof detail.unresolvedChunks === 'number' &&
      'generation' in detail && typeof detail.generation === 'number',
    `Review detail carried no counts: ${JSON.stringify(detail)}`
  )
  return { unresolvedChunks: detail.unresolvedChunks, generation: detail.generation }
}

function buildPatch (documentPath: string, from: string, to: string): string {
  return (
    `--- ${documentPath}\n` +
    `+++ ${documentPath}\n` +
    '@@ -1,3 +1,3 @@\n' +
    ' # Review gate\n' +
    ' \n' +
    `-${from}\n` +
    `+${to}\n`
  )
}

/**
 * Submits a proposal and waits for its chunk to render, leaving it unresolved.
 * Every pending-review test needs exactly this state; what happens to the
 * pending chunk afterwards is what differs.
 */
async function openReview (
  client: AgentClient,
  page: Page,
  documentPath: string,
  from: string,
  to: string,
  idempotencyKey: string
): Promise<string> {
  const documentId = documentIdOf(await client.get('/v1/documents'))
  const baselineSha256 = readSha256(
    await client.get(`/v1/documents/${documentId}/content?side=working`)
  )
  const reviewId = reviewIdOf(await client.post(
    `/v1/documents/${documentId}/proposals`,
    {
      baselineSha256,
      expectedReviewGeneration: 0,
      clientRequestId: idempotencyKey,
      claims: [
        {
          description: 'Left unresolved on purpose',
          patch: buildPatch(documentPath, from, to)
        }
      ]
    }
  ))
  await page
    .locator('button.cm-review-diff-control.accept')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  return reviewId
}

/**
 * Discards the review and flushes the buffer, so the window can close without
 * hitting either the save gate or the modal unsaved-changes prompt. A test that
 * leaves a review standing gets its fixture SIGKILLed during teardown.
 */
async function clearReviewAndFlush (
  page: Page,
  documentPath: string
): Promise<void> {
  // Disposing of the remaining chunks is the reviewer's alone, so this is the
  // status panel's own control — the gesture a user makes, carrying the fence
  // the pane already holds. No agent route can do it.
  await page.locator('button.cm-reviewClear').first().click()
  await page
    .locator('button.cm-review-diff-control.accept')
    .first()
    .waitFor({ state: 'detached', timeout: 20_000 })
  assert.deepEqual(
    await invokeSave(page, documentPath),
    { ok: true },
    'Saving must succeed once the review is cleared.'
  )
}

/**
 * The save-file IPC call MainEditor makes, issued from the page context.
 * `window.ipc` is the preload bridge, typed globally in source/global.d.ts.
 */
function invokeSave (page: Page, documentPath: string): Promise<unknown> {
  return page.evaluate(
    async ([documentPathInPage]) =>
      await window.ipc.invoke('documents:save-file', { path: documentPathInPage }),
    [documentPath]
  )
}

/**
 * Every refusal the provider logged, quoted into assertion messages. Empty when
 * the gate never closed, which is itself the information the message carries.
 */
function saveGateClosures (log: string): string {
  return log
    .split('\n')
    .filter(line => line.includes('Save gate closed'))
    .join('\n')
}

async function acceptEveryChunk (page: Page, timeoutMs: number): Promise<number> {
  const accept = page.locator('button.cm-review-diff-control.accept')
  await accept.first().waitFor({ state: 'visible', timeout: timeoutMs })

  let accepted = 0
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = await accept.count()
    if (remaining === 0) {
      break
    }
    await accept.first().click()
    accepted += 1
    // Accepting rewrites the merge reference and re-renders the controls; give
    // the plugin a frame before recounting so the click targets a live node.
    await delay(250)
  }

  assert.equal(
    await accept.count(),
    0,
    'Review controls remained after accepting every chunk.'
  )
  assert.ok(
    accepted > 0,
    'The review pane rendered no accept control, so nothing was proven.'
  )
  return accepted
}

/** Everything the tests reach for, assembled once by boot() below. */
interface RunningFixture {
  appProcess: ChildProcess | undefined
  browser: Browser | undefined
  fixtureRoot: string | undefined
  documentPath: string | undefined
  getOutput: () => string
  client: AgentClient | undefined
  rendererEvents: string[]
  screenshots: Map<string, Buffer>
}

async function boot (fixture: RunningFixture, timeoutMs: number): Promise<void> {
  const agentApi = { enabled: true, port: 39001 }
  const created = await createFixture('zettlr-review-diff-save-gate-e2e-', {
    documentName: 'reviewed-document.md',
    documentContents: DOCUMENT_CONTENTS,
    // Vim input mode gives this spec a save gesture it can actually perform:
    // `:w` is a CodeMirror Ex command handled in the renderer, whereas Ctrl+S
    // is a main-process menu accelerator that CDP-injected keys cannot fire.
    config: {
      agentApi,
      editor: { inputMode: 'vim' }
    }
  })
  fixture.fixtureRoot = created.root
  fixture.documentPath = created.documentPath
  const app = await attach(created.configDirectory, fixture.rendererEvents, timeoutMs)
  fixture.appProcess = app.appProcess
  fixture.browser = app.browser
  fixture.getOutput = app.getOutput
  fixture.client = agentClient(agentApi.port)
  await waitForAgentApi(fixture.client, 60_000)
}

async function teardown (fixture: RunningFixture): Promise<void> {
  await shutdown(fixture.browser, fixture.appProcess)
  await preserveArtifacts(
    ARTIFACT_DIRECTORY,
    fixture.fixtureRoot,
    fixture.getOutput(),
    fixture.rendererEvents,
    fixture.screenshots
  )
  if (fixture.fixtureRoot !== undefined) {
    await rm(fixture.fixtureRoot, { recursive: true, force: true })
  }
  console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`)
  assertCleanExit(fixture.getOutput())
}

describe('saving after accepting a reviewed change', function () {
  const running: RunningFixture = {
    appProcess: undefined,
    browser: undefined,
    fixtureRoot: undefined,
    documentPath: undefined,
    getOutput: () => '',
    client: undefined,
    rendererEvents: [],
    screenshots: new Map<string, Buffer>()
  }
  const { rendererEvents, screenshots } = running
  /** Set by the pending-save test; the reopen test proves it reattaches. */
  let pendingReviewId: string | undefined

  before(async function () {
    await boot(running, this.timeout())
  })

  after(async function () {
    await teardown(running)
  })

  it('writes the accepted text to disk instead of refusing the save', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeFixtureRoot = requireInitialized(running.fixtureRoot, 'The fixture root must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })

    const documentId = documentIdOf(await activeClient.get('/v1/documents'))
    const baselineSha256 = readSha256(
      await activeClient.get(`/v1/documents/${documentId}/content?side=working`)
    )

    await activeClient.post(
      `/v1/documents/${documentId}/proposals`,
      {
        baselineSha256,
        expectedReviewGeneration: 0,
        clientRequestId: 'e2e-review-diff-save-gate',
        claims: [
          {
            description: 'Abbreviate simple normal crossings',
            patch: buildPatch(activeDocumentPath, ORIGINAL_PHRASE, PROPOSED_PHRASE)
          }
        ]
      }
    )

    await acceptEveryChunk(page, 30_000)
    screenshots.set('review-accepted.png', await page.screenshot())

    // The editor must hold the accepted text before the save is meaningful.
    const bufferText = await page.locator('.cm-content').innerText()
    assert.ok(
      bufferText.includes(PROPOSED_PHRASE),
      `Accepting the chunk did not put the proposed text in the buffer.\n` +
        `Buffer: ${JSON.stringify(bufferText)}`
    )

    // Same call MainEditor.vue makes for the save-file shortcut, so this
    // exercises the real gate rather than a test-only path.
    // Invoked directly rather than through Ctrl+S: the save shortcut is a
    // main-process menu accelerator, and CDP-injected key events do not run
    // accelerators, so a keypress here saves nothing. This is the same IPC call
    // MainEditor makes, so it covers the provider contract end to end; what it
    // does not cover is MainEditor's own presentation of the result.
    const saved = await invokeSave(page, activeDocumentPath)

    assert.deepEqual(
      saved,
      { ok: true },
      'The provider refused to save an accepted review. Gate closures logged:\n' +
        `${saveGateClosures(await readAppLog(activeFixtureRoot))}\n` +
        outputTail(running.getOutput())
    )
    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      SAVED_CONTENTS,
      'The saved file must contain exactly the accepted text.'
    )
    // A refusal now surfaces as a closable error toast rather than a blocking
    // modal, so its absence is part of the proof.
    assert.equal(
      await page.locator('#zettlr-toast-container .zettlr-toast.error').count(),
      0,
      'Saving an accepted review must not raise an error toast.'
    )
    assert.deepEqual(
      rendererEvents,
      [],
      `The renderer reported unexpected errors or dialogs:\n${rendererEvents.join('\n')}`
    )
  })

  it('keeps a chunk comment rendered and agent-readable after saving', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())

    const reviewId = await openReview(
      activeClient,
      page,
      activeDocumentPath,
      PROPOSED_PHRASE,
      STRICT_PHRASE,
      'e2e-review-diff-save-gate-note'
    )
    const chunksPayload = await activeClient.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(
      chunksPayload !== null &&
        typeof chunksPayload === 'object' &&
        'chunks' in chunksPayload &&
        Array.isArray(chunksPayload.chunks) &&
        chunksPayload.chunks.length === 1,
      `Chunk-note proof expected one addressable chunk: ${JSON.stringify(chunksPayload)}`
    )

    // The note is the reviewer's, typed into the chunk's own field. There is
    // no submit gesture: the reviewer types and walks away — no blur, no
    // Enter — and the autosave must still make the note agent-visible. That
    // is the product scenario this spec exists to prove, so the API is
    // polled BEFORE anything else touches the pane.
    const chunkWidget = page.locator('.cm-chunkControls').first()
    await chunkWidget
      .locator('input.cm-chunkCommentInput')
      .fill('Preserve this note across save')
    const agentSeesNote = async (): Promise<boolean> => {
      const payload = await activeClient.get(`/v1/reviews/${reviewId}/chunks`)
      return payload !== null && typeof payload === 'object' &&
        'chunks' in payload && Array.isArray(payload.chunks) &&
        payload.chunks.length === 1 &&
        (payload.chunks[0] as { comment?: unknown }).comment === 'Preserve this note across save'
    }
    const noteDeadline = Date.now() + 20_000
    while (Date.now() < noteDeadline && !(await agentSeesNote())) {
      await delay(250)
    }
    assert.ok(
      await agentSeesNote(),
      'The typed note must become agent-visible without blur or any submit gesture.'
    )

    const note = page.locator('.cm-chunkComment').first()
    await note.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await note.innerText(),
      'Preserve this note across save',
      'The annotated chunk must render its note before save.'
    )
    screenshots.set('review-note-before-save.png', await page.screenshot())

    assert.deepEqual(
      await invokeSave(page, activeDocumentPath),
      { ok: true },
      'An annotated review must save as-is.'
    )
    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      `# Review gate\n\n${STRICT_PHRASE}\n`,
      'Saving an annotated review must persist its working text.'
    )

    await note.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await note.innerText(),
      'Preserve this note across save',
      'FILE_SAVED must not clear the note from the pane.'
    )
    // The note is agent-readable on the chunk itself, and the chunk is
    // still outstanding after the save.
    const afterChunks = await activeClient.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(
      afterChunks !== null && typeof afterChunks === 'object' &&
        'chunks' in afterChunks && Array.isArray(afterChunks.chunks) &&
        afterChunks.chunks.length === 1,
      `The chunk must stay outstanding after the save: ${JSON.stringify(afterChunks)}`
    )
    const [annotated] = afterChunks.chunks as Array<{ comment?: unknown }>
    assert.equal(
      annotated.comment,
      'Preserve this note across save',
      'The agent must read the reviewer\'s note on the chunk itself.'
    )
    screenshots.set('review-note-after-save.png', await page.screenshot())

    await clearReviewAndFlush(page, activeDocumentPath)
  })

  it('saves a pending review as-is and keeps it open', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeFixtureRoot = requireInitialized(running.fixtureRoot, 'The fixture root must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())

    // The previous test completed its review, so this opens a fresh one and
    // deliberately leaves the chunk unresolved. Saving persists the document
    // as-is — proposal included — and the review's status alongside it.
    pendingReviewId = await openReview(
      activeClient,
      page,
      activeDocumentPath,
      PROPOSED_PHRASE,
      STRICT_PHRASE,
      'e2e-review-diff-save-gate-pending'
    )

    const before = await reviewCounts(activeClient, pendingReviewId)
    assert.equal(before.unresolvedChunks, 1, 'The pending chunk must be open before the save.')

    const saved = await invokeSave(page, activeDocumentPath)
    assert.deepEqual(
      saved,
      { ok: true },
      'The provider refused to save a pending review. Gate closures logged:\n' +
        `${saveGateClosures(await readAppLog(activeFixtureRoot))}\n` +
        outputTail(running.getOutput())
    )
    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      PENDING_SAVED_CONTENTS,
      'The saved file must contain exactly the working text, proposal included.'
    )
    screenshots.set('pending-save.png', await page.screenshot())

    // The review is untouched by the save: same pending chunk, same
    // generation, and the pane still renders its decidable widget.
    const after = await reviewCounts(activeClient, pendingReviewId)
    assert.equal(after.unresolvedChunks, 1, 'The pending chunk must survive the save.')
    assert.equal(after.generation, before.generation, 'A save must not advance the review generation.')
    await page
      .locator('button.cm-review-diff-control.accept')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await page.locator('#zettlr-toast-container .zettlr-toast.error').count(),
      0,
      'Saving a pending review must not raise an error toast.'
    )

    // The fence moved to the saved content, so the document is clean: a fresh
    // save is not refused as external drift and the review survives it too.
    assert.deepEqual(
      await invokeSave(page, activeDocumentPath),
      { ok: true },
      'A second save of the already-saved pending review must succeed.'
    )
    assert.equal(
      (await reviewCounts(activeClient, pendingReviewId)).unresolvedChunks,
      1,
      'The pending chunk must survive the second save as well.'
    )
  })

  it('reattaches the saved pending review when the document reopens', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    const savedReviewId = requireInitialized(pendingReviewId, 'The previous test must have saved a pending review')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())

    // The document was saved with its pending review, so closing it is free —
    // this is exactly what the old refusal made impossible: putting a pending
    // review down and coming back to it later.
    await page.evaluate(
      async ([pathInPage]) =>
        await window.ipc.invoke('documents-provider', {
          command: 'close-file-everywhere',
          payload: { path: pathInPage }
        }),
      [activeDocumentPath]
    )
    await page
      .locator('button.cm-review-diff-control.accept')
      .first()
      .waitFor({ state: 'detached', timeout: 20_000 })

    // Focus is the operation that deliberately takes a pane, and opening the
    // file is what reattaches its sidecar-backed review.
    const documentId = await workspaceDocumentId(activeClient, activeDocumentPath)
    await activeClient.post(`/v1/documents/${documentId}/focus`, {})
    await page
      .locator('button.cm-review-diff-control.accept')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
    screenshots.set('pending-review-reattached.png', await page.screenshot())

    const reattached = await reviewCounts(activeClient, savedReviewId)
    assert.equal(
      reattached.unresolvedChunks,
      1,
      'The reopened document must reattach the review with its pending chunk intact.'
    )

    await clearReviewAndFlush(page, activeDocumentPath)
  })

  it('saves a pending review through the vim :w gesture without an error toast', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())

    await openReview(
      activeClient,
      page,
      activeDocumentPath,
      // Clearing the previous review discarded it, so disk and working text are
      // both back to the text the first test saved.
      PROPOSED_PHRASE,
      SNC_PHRASE,
      'e2e-review-diff-save-gate-vim-write'
    )

    // A real save gesture, all the way through the renderer: the vim `:w` Ex
    // command runs in the editor, calls the same save IPC, and owns the
    // presentation of whatever comes back. Nothing here reaches into the
    // provider, so this is what proves a user's own save gesture now succeeds
    // on a pending review.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Escape')
    await page.keyboard.type(':w')
    await page.keyboard.press('Enter')

    const expected = `# Review gate\n\n${SNC_PHRASE}\n`
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await readFile(activeDocumentPath, 'utf8') === expected) {
        break
      }
      await delay(250)
    }
    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      expected,
      'The :w save must write the pending working text as-is.'
    )
    assert.equal(
      await page.locator('#zettlr-toast-container .zettlr-toast.error').count(),
      0,
      'Saving a pending review with :w must not raise an error toast.'
    )
    // The review is still open and decidable after the gesture.
    await page
      .locator('button.cm-review-diff-control.accept')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    screenshots.set('pending-save-vim-write.png', await page.screenshot())

    await clearReviewAndFlush(page, activeDocumentPath)
  })
})

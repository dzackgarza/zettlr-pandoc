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
 * Both refusal tests need exactly this state; the accept path is what differs.
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
  client: AgentClient,
  page: Page,
  reviewId: string,
  documentPath: string
): Promise<void> {
  // Clearing is a decision like any other: it binds to the generation and
  // working hash of the chunk list it is sweeping away.
  const chunks = await client.get(`/v1/reviews/${reviewId}/chunks`)
  assert.ok(
    chunks !== null &&
      typeof chunks === 'object' &&
      'generation' in chunks &&
      typeof chunks.generation === 'number' &&
      'workingSha256' in chunks &&
      typeof chunks.workingSha256 === 'string',
    `Clearing needs the chunk list's fence values: ${JSON.stringify(chunks)}`
  )
  await client.post(`/v1/reviews/${reviewId}/clear`, {
    expectedReviewGeneration: chunks.generation,
    expectedWorkingSha256: chunks.workingSha256
  })
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
      await window.ipc.invoke('documents-provider', {
        command: 'save-file',
        payload: { path: documentPathInPage }
      }),
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

  it('keeps a held review rendered after saving it', async function () {
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
      'e2e-review-diff-save-gate-held'
    )
    const chunksPayload = await activeClient.get(`/v1/reviews/${reviewId}/chunks`)
    assert.ok(
      chunksPayload !== null &&
        typeof chunksPayload === 'object' &&
        'chunks' in chunksPayload &&
        Array.isArray(chunksPayload.chunks) &&
        chunksPayload.chunks.length === 1 &&
        typeof chunksPayload.chunks[0].chunkId === 'string',
      `Held-review proof expected one addressable chunk: ${JSON.stringify(chunksPayload)}`
    )
    const chunkId: unknown = chunksPayload.chunks[0].chunkId
    assert.equal(
      typeof chunkId,
      'string',
      `Held-review proof received a non-string chunk id: ${JSON.stringify(chunkId)}`
    )
    // The chunk list is the fence: the hold binds to the generation and
    // working hash it was partitioned from, exactly as a real client must.
    assert.ok(
      'generation' in chunksPayload &&
        typeof chunksPayload.generation === 'number' &&
        'workingSha256' in chunksPayload &&
        typeof chunksPayload.workingSha256 === 'string',
      `Held-review proof needs the chunk list's fence values: ${JSON.stringify(chunksPayload)}`
    )
    await activeClient.post(
      `/v1/reviews/${reviewId}/chunks/${chunkId}/hold`,
      {
        comment: 'Preserve this decision across save',
        expectedReviewGeneration: chunksPayload.generation,
        expectedWorkingSha256: chunksPayload.workingSha256
      }
    )

    const heldWidget = page.locator('.cm-deletedChunk.held').first()
    await heldWidget.waitFor({ state: 'visible', timeout: 20_000 })
    assert.ok(
      (await heldWidget.innerText()).includes('Held: Preserve this decision across save'),
      'The held chunk must render its durable comment before save.'
    )
    screenshots.set('review-held-before-save.png', await page.screenshot())

    assert.deepEqual(
      await invokeSave(page, activeDocumentPath),
      { ok: true },
      'A held-only review must pass the save gate.'
    )
    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      `# Review gate\n\n${STRICT_PHRASE}\n`,
      'Saving a held review must persist its working text.'
    )

    await heldWidget.waitFor({ state: 'visible', timeout: 20_000 })
    assert.ok(
      (await heldWidget.innerText()).includes('Held: Preserve this decision across save'),
      'FILE_SAVED must not clear the active held review from the pane.'
    )
    const detail = await activeClient.get(`/v1/reviews/${reviewId}`)
    assert.ok(
      detail !== null &&
        typeof detail === 'object' &&
        'heldChunks' in detail &&
        detail.heldChunks === 1,
      `The provider must retain the held review after save: ${JSON.stringify(detail)}`
    )
    screenshots.set('review-held-after-save.png', await page.screenshot())

    await clearReviewAndFlush(activeClient, page, reviewId, activeDocumentPath)
  })

  it('refuses an unresolved review with a typed reason, not a modal', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())

    // The previous test completed its review, so this opens a fresh one and
    // deliberately leaves the chunk unresolved.
    const reviewId = await openReview(
      activeClient,
      page,
      activeDocumentPath,
      PROPOSED_PHRASE,
      STRICT_PHRASE,
      'e2e-review-diff-save-gate-unresolved'
    )

    const contentsBefore = await readFile(activeDocumentPath, 'utf8')

    // This resolving at all is the non-modal contract: a blocking
    // dialog.showErrorBox in the gate would leave this promise pending forever.
    // The reason travels with the result so the renderer can name it.
    const saved = await invokeSave(page, activeDocumentPath)
    assert.deepEqual(
      saved,
      {
        ok: false,
        refusal: {
          reason: 'unresolved-chunks',
          message: 'Accept, reject, or hold every chunk before saving this review.'
        }
      },
      'The provider must refuse an unresolved review with a typed reason.'
    )
    screenshots.set('save-refused.png', await page.screenshot())

    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      contentsBefore,
      'A refused save must not touch the file.'
    )

    await clearReviewAndFlush(activeClient, page, reviewId, activeDocumentPath)
  })

  it('shows the refusal on a dismissable toast when the user saves with :w', async function () {
    const activeClient = requireInitialized(running.client, 'The Agent API client must be initialized')
    const activeDocumentPath = requireInitialized(running.documentPath, 'The document path must be initialized')
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())

    const reviewId = await openReview(
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
    // provider, so this is what proves the refusal is visible to a user.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Escape')
    await page.keyboard.type(':w')
    await page.keyboard.press('Enter')

    const toast = page.locator('#zettlr-toast-container .zettlr-toast.error')
    await toast.first().waitFor({ state: 'visible', timeout: 20_000 })
    screenshots.set('refusal-toast.png', await page.screenshot())
    // First span is the message; the second is the ✕ dismiss affordance.
    assert.equal(
      await toast.first().locator('span').first().innerText(),
      'Accept, reject, or hold every chunk before saving this review.',
      'The toast must name the provider\'s reason, not a generic failure.'
    )
    assert.equal(
      await readFile(activeDocumentPath, 'utf8'),
      SAVED_CONTENTS,
      'The refused :w must not touch the file.'
    )

    // Dismissable is the whole point of the redesign: the modal this replaced
    // could not be closed from inside the app, which is how a refused save
    // froze the window.
    await toast.first().click()
    await toast.first().waitFor({ state: 'detached', timeout: 5_000 })
    assert.equal(
      await toast.count(),
      0,
      'The refusal toast must dismiss on click.'
    )

    await clearReviewAndFlush(activeClient, page, reviewId, activeDocumentPath)
  })
})

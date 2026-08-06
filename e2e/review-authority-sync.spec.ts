/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: review decision / document authority synchronization
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: A review decision is bound to the bytes the reviewer was
 *              looking at when they clicked. Those bytes only mean something
 *              to main once the editor's collab updates have reached the
 *              document authority, so every decision waits for that
 *              confirmation before it hashes anything and before the provider
 *              is asked to mutate.
 *
 *              Only the assembled app can prove it: the wait lives in the
 *              renderer, the hash comparison lives in main, and the failure
 *              they produce together — a decision refused for text main was
 *              never told about — appears nowhere below the two processes.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import type { ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { createPatch } from 'diff'
import type { Browser, Page } from 'playwright'
import {
  agentClient,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  requireInitialized,
  reserveFreePort,
  shutdown,
  waitForAgentApi,
  type AgentClient
} from './support/electron-app'

const BASELINE = [
  '# Authority sync', '',
  'alpha original', '',
  'bravo original', '',
  'charlie original', '',
  'delta original', '',
  'echo original', ''
].join('\n')

/**
 * The CodeMirror view behind a mounted pane, as this spec drives it. Reached
 * through the same DOM property `EditorView.findFromDOM` uses, because the
 * editor module itself is not addressable from the page.
 */
interface PageEditorView {
  state: {
    doc: {
      lines: number
      line: (number: number) => { from: number, to: number, text: string }
      toString: () => string
    }
  }
  dispatch: (spec: unknown) => void
}

/** The editor content element, with the CodeMirror handle it carries. */
interface PageContentElement extends Element {
  cmTile?: { root?: { view?: PageEditorView } }
}

interface RaceInput {
  /** Which mounted pane is edited, in DOM order. */
  editPane: number
  /** Which mounted pane is clicked. The same one, unless a race needs two. */
  clickPane: number
  /** The working line edited twice, by its exact text before the first edit. */
  line: string
  /** What that line reads after the first, then the second, edit. */
  edits: [string, string]
  /** The control clicked, as a selector resolved inside the clicked pane. */
  control: string
  /** Reference text naming the chunk whose control is clicked, if any. */
  chunk?: string
}

/**
 * Two editor edits and one review click, in a SINGLE renderer task.
 *
 * This is the authority-push barrier the race needs, and it is the product's
 * own: the remote-doc plugin pushes one batch at a time and drops any further
 * push while one is in flight. Dispatching both edits and then clicking
 * without ever yielding the renderer's event loop therefore GUARANTEES the
 * state the race requires — the first push unresolved, the second edit never
 * sent — with no sleep, no timing assumption, and nothing injected into the
 * product. A build whose decision did not wait would send its hash from
 * exactly here, before main has either edit, and be refused for it.
 *
 * Returns the edited pane's buffer text at click time: what the reviewer was
 * looking at, and what every assertion below compares against.
 */
async function raceEditsWithClick (page: Page, input: RaceInput): Promise<string> {
  return await page.evaluate((options: RaceInput) => {
    const contents = Array.from(
      document.querySelectorAll<PageContentElement>('.cm-content')
    )
    const paneAt = (index: number): PageContentElement => {
      const content = contents[index]
      if (content === undefined) {
        throw new Error(
          `No editor pane at index ${index}; ${contents.length} are mounted`
        )
      }
      return content
    }
    const content = paneAt(options.editPane)
    const view = content.cmTile?.root?.view
    if (view === undefined) {
      throw new Error('The mounted pane exposes no CodeMirror view')
    }

    const replaceLine = (from: string, to: string): void => {
      const doc = view.state.doc
      for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number)
        if (line.text === from) {
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: to },
            userEvent: 'input.type'
          })
          return
        }
      }
      throw new Error(`No line reads ${JSON.stringify(from)}`)
    }

    replaceLine(options.line, options.edits[0])
    replaceLine(options.edits[0], options.edits[1])

    // Resolved after the edits: an edit inside a chunk rebuilds its widget, so
    // a node found beforehand would be detached by the time it was clicked.
    const pane = paneAt(options.clickPane).closest('.cm-editor')
    if (pane === null) {
      throw new Error('The editor content is not inside a .cm-editor')
    }
    const scope = options.chunk === undefined
      ? pane
      : Array.from(pane.querySelectorAll('.cm-deletedChunk')).find(
        widget => widget.textContent?.includes(options.chunk as string)
      )
    if (scope === undefined) {
      throw new Error(`No chunk widget names ${JSON.stringify(options.chunk)}`)
    }
    const button = scope.querySelector(options.control)
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`No control matches ${options.control}`)
    }
    if (button.disabled) {
      throw new Error(`The control ${options.control} is disabled`)
    }

    const textAtClick = view.state.doc.toString()
    button.click()
    return textAtClick
  }, input)
}

/**
 * tsx compiles this spec through esbuild with `keepNames`, which rewrites
 * every named function into `__name(fn, 'name')`. `page.evaluate` ships a
 * function's compiled source to the renderer, where that helper does not
 * exist, so define it there once. It is inert, and the application never
 * looks at it.
 */
async function definePageNameHelper (page: Page): Promise<void> {
  await page.evaluate(
    'globalThis.__name = globalThis.__name ?? (function (fn) { return fn })'
  )
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

async function openDocumentId (api: AgentClient): Promise<string> {
  const payload = await api.get('/v1/documents')
  assert.ok(isRecord(payload) && Array.isArray(payload.documents))
  assert.equal(
    payload.documents.length,
    1,
    `unexpected open documents: ${JSON.stringify(payload)}`
  )
  return stringField(payload.documents[0], 'documentId')
}

/** The provider's authoritative working text, as bytes. */
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

/** The chunk partition and the fence values a decision has to bind to. */
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

/**
 * Submits one proposal against whatever the provider currently holds, and
 * returns its review id once the pane has rendered the controls.
 */
async function propose (
  api: AgentClient,
  page: Page,
  clientRequestId: string,
  claims: Array<{ description: string, patch: string }>
): Promise<string> {
  const documentId = await openDocumentId(api)
  const content = await api.get(`/v1/documents/${documentId}/content?side=working`)
  assert.ok(isRecord(content) && isRecord(content.revision))
  assert.equal(typeof content.reviewGeneration, 'number')
  const reviewId = stringField(
    await api.post(`/v1/documents/${documentId}/proposals`, {
      baselineSha256: stringField(content.revision, 'sha256'),
      expectedReviewGeneration: content.reviewGeneration,
      clientRequestId,
      claims
    }),
    'reviewId'
  )
  await page
    .locator('button.cm-review-diff-control.accept')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  return reviewId
}

/** Every toast currently on screen, as its message text. */
async function toastMessages (page: Page): Promise<string[]> {
  return await page
    .locator('#zettlr-toast-container .zettlr-toast span:first-child')
    .allInnerTexts()
}

/** Polls `probe` until `holds` accepts what it answers. */
async function waitFor<T> (
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
    await delay(100)
    last = await probe()
  }
  throw new Error(`Timed out waiting for ${what}. Last value: ${JSON.stringify(last)}`)
}

/**
 * The provider's chunk list once it satisfies `holds`, with the pane redrawn
 * from it. A decision is settled only when both agree, and waiting on the
 * widgets alone would not do: they leave the pane for as long as the buffer
 * runs ahead of the authority, which is exactly the window this spec puts
 * them in. Their absence is the race, not the outcome.
 */
async function settledChunks (
  api: AgentClient,
  page: Page,
  reviewId: string,
  holds: (chunks: ChunkView[]) => boolean
): Promise<ChunkView[]> {
  const chunks = await waitFor(
    async () => (await chunkListing(api, reviewId)).chunks,
    holds,
    'the provider to commit the decision'
  )
  await waitFor(
    async () => await page.locator('.cm-deletedChunk').count(),
    count => count === chunks.length,
    `the pane to redraw ${chunks.length} chunk widget(s)`
  )
  return chunks
}

describe('a review decision waits for the document authority', function () {
  // One cold `forge start` compile plus the interactions below.
  this.timeout(300_000)

  let fixtureRoot: string | undefined
  let documentPath: string | undefined
  let browser: Browser | undefined
  let appProcess: ChildProcess | undefined
  let api: AgentClient | undefined
  let page: Page | undefined
  let reviewId: string | undefined

  before(async function () {
    const port = await reserveFreePort()
    const fixture = await createFixture('zettlr-review-authority-sync-', {
      documentName: 'authority-sync.md',
      documentContents: BASELINE,
      config: { agentApi: { enabled: true, port } }
    })
    fixtureRoot = fixture.root
    documentPath = fixture.documentPath
    const running = await attach(fixture.configDirectory, [], this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    await waitForAgentApi(port, 60_000)
    api = agentClient(port)
    page = await findEditorPage(running.browser, this.timeout())
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await definePageNameHelper(page)
    await hideDevServerOverlay(page)

    const proposed = BASELINE.replace(/ original/g, ' proposed')
    reviewId = await propose(api, page, 'authority-sync-1', [
      { description: 'Rewrite every line', patch: patch(fixture.documentPath, BASELINE, proposed) }
    ])
  })

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('accepts the edited chunk, not the chunk the pane was drawn with', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const drawn = await settledChunks(
      activeApi,
      activePage,
      activeReviewId,
      chunks => chunks.length === 5
    )
    assert.equal(drawn.length, 5, 'the proposal must partition into five chunks')

    const textAtClick = await raceEditsWithClick(activePage, {
      editPane: 0,
      clickPane: 0,
      line: 'alpha proposed',
      edits: ['alpha proposed one', 'alpha proposed one two'],
      chunk: 'alpha original',
      control: 'button.cm-review-diff-control.accept'
    })

    const chunks = await settledChunks(activeApi, activePage, activeReviewId, list =>
      list.every(chunk => !chunk.referenceText.includes('alpha original'))
    )
    assert.equal(chunks.length, 4, 'exactly the accepted chunk leaves the partition')
    assert.deepEqual(
      await toastMessages(activePage),
      [],
      'a decision that waited for the authority is never refused'
    )
    assert.equal(
      await workingText(activeApi),
      textAtClick,
      'accepting keeps the working text the reviewer was looking at'
    )

    // The decisive part: the accepted reference is the EDITED text. Had the
    // provider accepted the chunk as the pane was drawn — before either edit
    // was confirmed — the two edits would still differ from the reference and
    // would be sitting here as a fresh outstanding chunk.
    assert.deepEqual(
      chunks.filter(chunk => chunk.workingText.includes('alpha')),
      [],
      'accepting the edited chunk must leave nothing about alpha outstanding'
    )
  })

  it('rejects the edited chunk back to its reference text', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const textAtClick = await raceEditsWithClick(activePage, {
      editPane: 0,
      clickPane: 0,
      line: 'bravo proposed',
      edits: ['bravo proposed one', 'bravo proposed one two'],
      chunk: 'bravo original',
      control: 'button.cm-review-diff-control.reject'
    })

    const chunks = await settledChunks(activeApi, activePage, activeReviewId, list =>
      list.every(chunk => !chunk.referenceText.includes('bravo original'))
    )
    assert.equal(chunks.length, 3, 'exactly the rejected chunk leaves the partition')
    assert.deepEqual(await toastMessages(activePage), [])
    assert.equal(
      await workingText(activeApi),
      textAtClick.replace('bravo proposed one two', 'bravo original'),
      'rejecting the edited chunk restores its reference text and nothing else'
    )
  })

  it('holds the edited chunk with the exact text visible at click time', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const textAtClick = await raceEditsWithClick(activePage, {
      editPane: 0,
      clickPane: 0,
      line: 'charlie proposed',
      edits: ['charlie proposed one', 'charlie proposed one two'],
      chunk: 'charlie original',
      control: 'button.cm-review-diff-control.hold'
    })

    const chunks = await settledChunks(activeApi, activePage, activeReviewId, list =>
      list.some(chunk => chunk.state === 'held')
    )
    assert.equal(chunks.length, 3, 'holding adjudicates nothing, so nothing leaves')
    await activePage
      .locator('.cm-deletedChunk.held')
      .filter({ hasText: 'charlie original' })
      .waitFor({ state: 'visible', timeout: 30_000 })
    assert.deepEqual(await toastMessages(activePage), [])
    // A hold moves no text, so the provider's working text must be, byte for
    // byte, what was on screen when the control was clicked.
    assert.equal(await workingText(activeApi), textAtClick)

    const held = chunks.filter(chunk => chunk.state === 'held')
    assert.equal(held.length, 1, `exactly one chunk must be held: ${JSON.stringify(chunks)}`)
    assert.equal(
      held[0].workingText,
      'charlie proposed one two',
      'the hold must name the edited chunk, not the one the pane was drawn with'
    )
  })

  it('accepts every remaining chunk against the text at click time', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const textAtClick = await raceEditsWithClick(activePage, {
      editPane: 0,
      clickPane: 0,
      line: 'delta proposed',
      edits: ['delta proposed one', 'delta proposed one two'],
      control: 'button.cm-reviewAcceptAll'
    })

    await waitFor(
      async () => await activeApi.get(`/v1/reviews/${activeReviewId}`),
      value => isRecord(value) && value.unresolvedChunks === 0 && value.heldChunks === 0,
      'the review to hold no unresolved or held chunk'
    )
    // The review survives its last decision — it is resolved, awaiting the
    // save that closes it — so the status panel stays and reports the empty
    // partition. What must be gone is every chunk widget.
    await waitFor(
      async () => await activePage.locator('.cm-deletedChunk').count(),
      count => count === 0,
      'every chunk widget to leave the pane'
    )
    assert.equal(
      await activePage.locator('.cm-reviewStatusLabel').innerText(),
      '0 outstanding'
    )
    assert.deepEqual(await toastMessages(activePage), [])
    assert.equal(
      await workingText(activeApi),
      textAtClick,
      'accepting everything keeps every byte that was on screen'
    )
  })

  it('rejects every remaining chunk, discarding the edits inside them', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activePath = requireInitialized(documentPath, 'the document path must be initialized')

    const before = await workingText(activeApi)
    const rejectedReviewId = await propose(activeApi, activePage, 'authority-sync-2', [
      {
        description: 'Rewrite the echo line again',
        patch: patch(activePath, before, before.replace('echo proposed', 'echo revised'))
      }
    ])
    await settledChunks(activeApi, activePage, rejectedReviewId, chunks => chunks.length === 1)

    const textAtClick = await raceEditsWithClick(activePage, {
      editPane: 0,
      clickPane: 0,
      line: 'echo revised',
      edits: ['echo revised one', 'echo revised one two'],
      control: 'button.cm-reviewClear'
    })
    assert.ok(
      textAtClick.includes('echo revised one two'),
      'both edits must be in the buffer when the control is clicked'
    )

    await waitFor(
      async () => await workingText(activeApi),
      text => text === before,
      'the rejected proposal to leave the text it was made against'
    )
    await activePage
      .locator('.cm-reviewStatusPanel')
      .waitFor({ state: 'detached', timeout: 30_000 })
    assert.deepEqual(await toastMessages(activePage), [])
  })

  it('refuses a decision when another pane changed the document after the sync', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activePath = requireInitialized(documentPath, 'the document path must be initialized')

    // A second pane on the same document, through the provider's own split.
    // The window id is the one this renderer was opened with, and the leaf id
    // comes from the provider's own tab config: assuming either would test the
    // fixture rather than the app.
    const paneCount = await activePage.evaluate(async (pathInPage: string) => {
      const windowId = new URLSearchParams(location.search).get('window_id')
      if (windowId === null) {
        throw new Error('The main window carries no window_id')
      }
      const readTree = async (): Promise<unknown> =>
        await window.ipc.invoke('documents-provider', {
          command: 'retrieve-tab-config',
          payload: { windowId }
        })
      const leafIds = (node: unknown): string[] => {
        const tree = node as { type: string, id: string, nodes: unknown[] }
        return tree.type === 'leaf' ? [tree.id] : tree.nodes.flatMap(leafIds)
      }

      const before = leafIds(await readTree())
      if (before.length !== 1) {
        throw new Error(`Expected a single leaf to split, found ${before.length}`)
      }
      await window.ipc.invoke('documents-provider', {
        command: 'split-leaf',
        payload: {
          originWindow: windowId,
          originLeaf: before[0],
          direction: 'vertical',
          insertion: 'after'
        }
      })
      // Splitting replaces the origin leaf with a branch, so the leaves to
      // open the document in are only knowable from the tree afterwards.
      const after = leafIds(await readTree())
      for (const leafId of after) {
        await window.ipc.invoke('documents-provider', {
          command: 'open-file',
          payload: { windowId, leafId, path: pathInPage, newTab: true }
        })
      }
      return after.length
    }, activePath)
    assert.equal(paneCount, 2, 'the split must produce a second leaf')
    const contents = activePage.locator('.cm-content')
    await contents.nth(1).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await contents.count(), 2, 'the document must be open in two panes')

    const before = await workingText(activeApi)
    const staleReviewId = await propose(activeApi, activePage, 'authority-sync-3', [
      {
        description: 'Rewrite the delta line',
        patch: patch(activePath, before, before.replace('delta proposed one two', 'delta final'))
      }
    ])
    const beforeDecision = await chunkListing(activeApi, staleReviewId)
    assert.equal(beforeDecision.chunks.length, 1)
    // One chunk, drawn in both panes.
    await waitFor(
      async () => await activePage.locator('.cm-deletedChunk').count(),
      count => count === 2,
      'both panes to draw the chunk'
    )

    // The second pane's edit is issued first and travels the same ordered IPC
    // channel, so it reaches the authority between the first pane's sync and
    // the provider taking its lock. The first pane has nothing unsent, so its
    // hash is formed at once — and names text that no longer exists by the
    // time the decision is applied.
    await raceEditsWithClick(activePage, {
      editPane: 1,
      clickPane: 0,
      line: '# Authority sync',
      edits: ['# Authority sync edited', '# Authority sync edited twice'],
      chunk: 'delta proposed one two',
      control: 'button.cm-review-diff-control.accept'
    })

    const toast = activePage.locator('#zettlr-toast-container .zettlr-toast.error')
    await toast.first().waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(
      await toast.first().locator('span').first().innerText(),
      'The document text changed after this decision was formed, so the chunk ' +
        'it names is not the chunk that would be decided. Re-read the chunks ' +
        'and decide again.',
      'the refusal must name the hash precondition, not a generic failure'
    )

    const afterDecision = await chunkListing(activeApi, staleReviewId)
    assert.equal(
      afterDecision.generation,
      beforeDecision.generation,
      'a refused decision must not advance the review generation'
    )
    assert.ok(
      afterDecision.chunks.some(
        chunk => chunk.chunkId === beforeDecision.chunks[0].chunkId
      ),
      'the chunk the refused decision named must still be outstanding'
    )
    await waitFor(
      async () => await workingText(activeApi),
      text => text.includes('# Authority sync edited twice'),
      'the authority to hold the other pane\'s edits'
    )

    // Leave the window closable: resolve the review and flush the buffer.
    await toast.first().click()
    // Disposing of the remaining chunks is the reviewer's: the status panel's
    // own control, which is the only surface that offers it.
    // Two panes draw the review, so this is the first panel's control.
    await activePage.locator('button.cm-reviewClear').first().click()
    await activePage
      .locator('.cm-reviewStatusPanel')
      .waitFor({ state: 'detached', timeout: 30_000 })
    assert.deepEqual(
      await activePage.evaluate(
        async (pathInPage: string) =>
          await window.ipc.invoke('documents:save-file', { path: pathInPage }),
        activePath
      ),
      { ok: true }
    )
    assert.equal(
      await readFile(activePath, 'utf8'),
      await workingText(activeApi),
      'the saved bytes are the provider\'s working text'
    )
  })
})

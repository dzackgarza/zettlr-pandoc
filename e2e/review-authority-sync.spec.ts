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
 *              looking at when they clicked. M9 moved every review control
 *              out of the editor and into the annotations panel, so the panel
 *              is what forms that binding: it sends the working-text hash of
 *              the collaboration snapshot it drew the chunk from, and main
 *              refuses any decision whose hash no longer names the text main
 *              holds.
 *
 *              Only the assembled app can prove it: the buffer is edited in
 *              one renderer surface, the fence is formed in another out of a
 *              main-process broadcast, and the hash comparison lives in main.
 *              Both outcomes they produce together — a decision that lands on
 *              the edited chunk, and one refused for text main was never told
 *              about — appear nowhere below the two processes.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import type { ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { createPatch } from 'diff'
import type { Browser, Locator, Page } from 'playwright'
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

/** The annotations panel: where every review control lives after M9. */
const PANEL = '#annotations-panel'

interface EditInput {
  /** Which mounted pane is edited, in DOM order. */
  editPane: number
  /** The working line edited twice, by its exact text before the first edit. */
  line: string
  /** What that line reads after the first, then the second, edit. */
  edits: [string, string]
  /**
   * A panel control clicked in the SAME renderer task as the edits. Omitted,
   * the helper only edits, and the caller clicks once the panel has redrawn
   * from the authority — which is what a reviewer can actually do.
   */
  click?: {
    /** Id of the chunk whose card is clicked, if any. */
    chunk?: string
    /** The control, as a selector resolved inside the panel or that card. */
    control: string
  }
}

/**
 * Two editor edits, and optionally one panel click, in a SINGLE renderer task.
 *
 * The barrier is the product's own: the remote-doc plugin pushes one batch at
 * a time and drops any further push while one is in flight. Dispatching both
 * edits without ever yielding the renderer's event loop therefore GUARANTEES
 * the first push is unresolved and the second edit unsent — with no sleep, no
 * timing assumption, and nothing injected into the product.
 *
 * A click issued from that same task carries the fence of the snapshot the
 * panel was DRAWN with, while the first edit is already travelling the same
 * ordered channel to the authority and takes its per-document lock first.
 * That is the refusal case, and the only one this helper clicks for.
 *
 * Returns the edited pane's buffer text at the end of the task.
 */
async function editLines (page: Page, input: EditInput): Promise<string> {
  return page.evaluate((options: EditInput) => {
    const contents = Array.from(
      document.querySelectorAll<PageContentElement>('.cm-content')
    )
    const content = contents[options.editPane]
    if (content === undefined) {
      throw new Error(
        `No editor pane at index ${options.editPane}; ${contents.length} are mounted`
      )
    }
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

    const textAfterEdits = view.state.doc.toString()
    if (options.click === undefined) {
      return textAfterEdits
    }

    const panel = document.querySelector('#annotations-panel')
    if (panel === null) {
      throw new Error('The annotations panel is not mounted')
    }
    // The cards carry the chunk's own id, which is what the provider listing
    // names it by too.
    const scope = options.click.chunk === undefined
      ? panel
      : panel.querySelector(`.suggestion-chunk[data-chunk-id="${options.click.chunk}"]`)
    if (scope === null) {
      throw new Error(`No suggestion card carries the id ${JSON.stringify(options.click.chunk)}`)
    }
    const button = scope.querySelector(options.click.control)
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`No control matches ${options.click.control}`)
    }
    if (button.disabled) {
      throw new Error(`The control ${options.click.control} is disabled`)
    }
    button.click()
    return textAfterEdits
  }, input)
}

/** The pane's buffer text: the bytes the reviewer is looking at right now. */
async function bufferText (page: Page, pane = 0): Promise<string> {
  return page.evaluate((index: number) => {
    const view = document
      .querySelectorAll<PageContentElement>('.cm-content')[index]
      ?.cmTile?.root?.view
    if (view === undefined) {
      throw new Error(`No mounted pane at index ${index} exposes a CodeMirror view`)
    }
    return view.state.doc.toString()
  }, pane)
}

/** The card the panel draws for one chunk. */
function panelChunk (page: Page, chunkId: string): Locator {
  return page.locator(`${PANEL} .suggestion-chunk[data-chunk-id="${chunkId}"]`)
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
  workingSpans: Array<{ from: number, to: number }>
  comment?: string
}

/**
 * The chunk covering a line, by the identity the provider and the renderer
 * share. Naming a chunk by the text it draws would tie this spec to how a
 * replacement is rendered -- which side of the seam the removed text sits on,
 * and whether the change reads as one span or several.
 */
function chunkOnLine (
  chunks: ChunkView[],
  documentText: string,
  lineText: string
): string {
  const lineFrom = documentText.indexOf(lineText)
  assert.notEqual(lineFrom, -1, `no line reads ${JSON.stringify(lineText)}`)
  const lineTo = lineFrom + lineText.length
  const owner = chunks.find(chunk =>
    chunk.workingSpans.some(span => span.from >= lineFrom && span.to <= lineTo)
  )
  assert.ok(owner !== undefined, `no chunk covers ${JSON.stringify(lineText)}`)
  return owner.chunkId
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
 * returns its review id once the panel has rendered the controls.
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
    .locator(`${PANEL} .suggestion-decision.accept`)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  return reviewId
}

/** Every toast currently on screen, as its message text. */
function toastMessages (page: Page): Promise<string[]> {
  return page
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
 * The provider's chunk list once it satisfies `holds`, with the panel redrawn
 * from it. A decision is settled only when both agree: the panel is where the
 * next decision is raised AND where its fence is formed, so acting on the
 * provider's answer alone would decide against a snapshot the reviewer has
 * not been shown.
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
    async () => await page.locator(`${PANEL} .suggestion-chunk`).count(),
    count => count === chunks.length,
    `the panel to redraw ${chunks.length} suggestion card(s)`
  )
  return chunks
}

/**
 * Waits until the panel's card for `chunkId` reads `text` on its inserted
 * side. The card slices that text out of the SAME working snapshot its fence
 * comes from, so this is the moment the panel stopped showing the chunk it
 * was drawn with and started showing the edited one. Nothing but the
 * authority's own broadcast can move it: the panel never reads the buffer.
 */
async function panelShowsInsertedText (
  page: Page,
  chunkId: string,
  text: string
): Promise<void> {
  await waitFor(
    async () => await panelChunk(page, chunkId).locator('ins').innerText(),
    value => value === text,
    `the panel card for ${chunkId} to redraw as ${JSON.stringify(text)}`
  )
}

/**
 * Waits until the panel offers no decision at all. A review outlives its last
 * decision — resolved, awaiting the save that closes it — so the inspector
 * itself stays mounted; what leaves is every card, because nothing is
 * outstanding to adjudicate.
 */
async function waitForNoCards (page: Page): Promise<void> {
  await waitFor(
    async () => await page.locator(`${PANEL} .suggestion-chunk`).count(),
    count => count === 0,
    'every suggestion card to leave the panel'
  )
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
    const fixture = await createFixture('zettlr-review-authority-sync-', {
      documentName: 'authority-sync.md',
      documentContents: BASELINE,
      config: {
        agentApi: { enabled: true, port: 0 },
        // Every review control lives in the sidebar's annotations panel (M9),
        // so the fixture opens the sidebar on that tab: the surface under
        // test has to be mounted before a review reaches it.
        window: { sidebarVisible: true, currentSidebarTab: 'annotations' }
      }
    })
    fixtureRoot = fixture.root
    documentPath = fixture.documentPath
    const running = await attach(fixture.configDirectory, [], this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    api = agentClient(await readAgentApiPort(fixture.configDirectory, 60_000))
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

    const acceptedChunk = chunkOnLine(drawn, await workingText(activeApi), 'alpha proposed')
    await editLines(activePage, {
      editPane: 0,
      line: 'alpha proposed',
      edits: ['alpha proposed one', 'alpha proposed one two']
    })
    await panelShowsInsertedText(activePage, acceptedChunk, 'alpha proposed one two')

    const textAtClick = await bufferText(activePage)
    await panelChunk(activePage, acceptedChunk)
      .locator('.suggestion-decision.accept')
      .click()

    const chunks = await settledChunks(activeApi, activePage, activeReviewId, list =>
      list.every(chunk => chunk.chunkId !== acceptedChunk)
    )
    assert.equal(chunks.length, 4, 'exactly the accepted chunk leaves the partition')
    assert.deepEqual(
      await toastMessages(activePage),
      [],
      'a decision fenced on the snapshot the panel drew is never refused'
    )
    assert.equal(
      await workingText(activeApi),
      textAtClick,
      'accepting keeps the working text the reviewer was looking at'
    )

    // The decisive part: the accepted reference is the EDITED text. Had the
    // provider accepted the chunk as the panel was first drawn — before either
    // edit reached the authority — the two edits would still differ from the
    // reference and would be sitting here as a fresh outstanding chunk.
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

    const rejectedChunk = chunkOnLine(
      (await chunkListing(activeApi, activeReviewId)).chunks,
      await workingText(activeApi),
      'bravo proposed'
    )
    await editLines(activePage, {
      editPane: 0,
      line: 'bravo proposed',
      edits: ['bravo proposed one', 'bravo proposed one two']
    })
    await panelShowsInsertedText(activePage, rejectedChunk, 'bravo proposed one two')

    const textAtClick = await bufferText(activePage)
    await panelChunk(activePage, rejectedChunk)
      .locator('.suggestion-decision.reject')
      .click()

    const chunks = await settledChunks(activeApi, activePage, activeReviewId, list =>
      list.every(chunk => chunk.chunkId !== rejectedChunk)
    )
    assert.equal(chunks.length, 3, 'exactly the rejected chunk leaves the partition')
    assert.deepEqual(await toastMessages(activePage), [])
    assert.equal(
      await workingText(activeApi),
      textAtClick.replace('bravo proposed one two', 'bravo original'),
      'rejecting the edited chunk restores its reference text and nothing else'
    )
  })

  it('comments on the edited chunk with the exact text visible at click time', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const notedChunk = chunkOnLine(
      (await chunkListing(activeApi, activeReviewId)).chunks,
      await workingText(activeApi),
      'charlie proposed'
    )
    await editLines(activePage, {
      editPane: 0,
      line: 'charlie proposed',
      edits: ['charlie proposed one', 'charlie proposed one two']
    })
    await panelShowsInsertedText(activePage, notedChunk, 'charlie proposed one two')

    const textAtClick = await bufferText(activePage)
    const noteField = panelChunk(activePage, notedChunk)
      .locator('input.suggestion-chunk-comment')
    await noteField.fill('second thoughts')
    // Enter is the field's commit gesture; the note is a fenced mutation like
    // any other decision, not a local draft.
    await noteField.press('Enter')

    const chunks = await settledChunks(activeApi, activePage, activeReviewId, list =>
      list.some(chunk => chunk.comment !== undefined)
    )
    assert.equal(chunks.length, 3, 'a comment adjudicates nothing, so nothing leaves')
    // The field is re-seeded from the provider's own note on every broadcast,
    // so what it reads back is the committed value, not the keystrokes.
    assert.equal(
      await noteField.inputValue(),
      'second thoughts',
      'the committed note is what the field keeps'
    )
    assert.deepEqual(await toastMessages(activePage), [])
    // A comment moves no text, so the provider's working text must be, byte
    // for byte, what was on screen when the control was clicked.
    assert.equal(await workingText(activeApi), textAtClick)

    const noted = chunks.filter(chunk => chunk.comment !== undefined)
    assert.equal(noted.length, 1, `exactly one chunk must carry the note: ${JSON.stringify(chunks)}`)
    assert.equal(
      noted[0].workingText,
      'charlie proposed one two',
      'the note must land on the edited chunk, not the one the panel was drawn with'
    )
  })

  it('accepts every remaining chunk against the text at click time', async function () {
    const activeApi = requireInitialized(api, 'the Agent API client must be initialized')
    const activePage = requireInitialized(page, 'the editor page must be initialized')
    const activeReviewId = requireInitialized(reviewId, 'the review must be open')

    const sweptChunk = chunkOnLine(
      (await chunkListing(activeApi, activeReviewId)).chunks,
      await workingText(activeApi),
      'delta proposed'
    )
    await editLines(activePage, {
      editPane: 0,
      line: 'delta proposed',
      edits: ['delta proposed one', 'delta proposed one two']
    })
    await panelShowsInsertedText(activePage, sweptChunk, 'delta proposed one two')

    const textAtClick = await bufferText(activePage)
    await activePage.locator(`${PANEL} .suggestion-accept-all`).click()

    await waitFor(
      async () => await activeApi.get(`/v1/reviews/${activeReviewId}`),
      value => isRecord(value) && value.unresolvedChunks === 0,
      'the review to hold no unresolved chunk'
    )
    // The review survives its last decision — it is resolved, awaiting the
    // save that closes it — but that state is the agent's to read: with
    // nothing outstanding, the panel offers no decision at all.
    await waitForNoCards(activePage)
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
    const [echoChunk] = await settledChunks(
      activeApi,
      activePage,
      rejectedReviewId,
      chunks => chunks.length === 1
    )

    await editLines(activePage, {
      editPane: 0,
      line: 'echo revised',
      edits: ['echo revised one', 'echo revised one two']
    })
    await panelShowsInsertedText(activePage, echoChunk.chunkId, 'echo revised one two')

    const textAtClick = await bufferText(activePage)
    assert.ok(
      textAtClick.includes('echo revised one two'),
      'both edits must be in the buffer when the control is clicked'
    )
    await activePage.locator(`${PANEL} .suggestion-clear`).click()

    await waitFor(
      async () => await workingText(activeApi),
      text => text === before,
      'the rejected proposal to leave the text it was made against'
    )
    await waitForNoCards(activePage)
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
    // One chunk, drawn once: the panel belongs to the window, not to a pane.
    await settledChunks(activeApi, activePage, staleReviewId, chunks => chunks.length === 1)

    // The second pane's edit is issued first and travels the same ordered IPC
    // channel, so it takes the provider's per-document lock before the
    // decision does. The panel's fence was formed in that same renderer task,
    // out of the snapshot it was drawn with — and names text that no longer
    // exists by the time the decision is applied.
    await editLines(activePage, {
      editPane: 1,
      line: '# Authority sync',
      edits: ['# Authority sync edited', '# Authority sync edited twice'],
      click: {
        chunk: beforeDecision.chunks[0].chunkId,
        control: '.suggestion-decision.accept'
      }
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
    // Disposing of the remaining chunks is the reviewer's: the panel's own
    // control, which is the only surface that offers it. It carries the fence
    // the panel now holds, which is why the refusal above had to be settled
    // first.
    await activePage.locator(`${PANEL} .suggestion-clear`).click()
    await waitForNoCards(activePage)
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

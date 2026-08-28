import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { chmod, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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

const MARKER = 'ZETTLR_E2E_VISIBLE_DOCUMENT_MARKER_4E8C8D8A'
const ARTIFACT_DIRECTORY = path.join(
  tmpdir(),
  'zettlr-document-open-e2e-latest'
)

async function waitForAppDiagnostic (
  fixtureRoot: string,
  documentPath: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const diagnostic = await readAppLog(fixtureRoot)
    if (diagnostic.includes(documentPath) && diagnostic.includes('EACCES')) {
      return
    }
    await delay(100)
  }

  throw new Error(
    `No app diagnostic identified ${documentPath} and EACCES within ${timeoutMs}ms.`
  )
}

async function readEditorDocument (page: Page): Promise<string> {
  return await page.locator('.cm-content').evaluate(content => {
    const tile = (
      content as HTMLElement & {
        cmTile?: {
          root?: {
            view?: {
              state?: { doc?: { toString(): string } }
            }
          }
        }
      }
    ).cmTile
    const documentText = tile?.root?.view?.state?.doc?.toString()
    if (documentText === undefined) {
      throw new Error('Could not read the active CodeMirror document state')
    }
    return documentText
  })
}

async function waitForEditorDocument (
  page: Page,
  expected: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.locator('.cm-content').count() > 0) {
      try {
        if (await readEditorDocument(page) === expected) {
          return
        }
      } catch {
        // The editor is still being replaced by roots-add; keep observing the
        // same real page until the requested cold-start document is active.
      }
    }
    await delay(100)
  }
  throw new Error(
    `The cold-start file was not active within ${timeoutMs}ms. ` +
    `Expected ${JSON.stringify(expected)}`
  )
}

describe('opening a Markdown document', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let documentPath: string | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createFixture('zettlr-document-open-e2e-', {
      documentName: 'opened-document.md',
      // The reference-UI test needs a citing location and the section it cites,
      // so the fixture document carries both.
      documentContents:
        `# Opened document\n\n${MARKER}\n\n` +
        'Standard terminology: see @sec:terminology.\n\n' +
        '# Terminology, notation, and standard background {#sec:terminology}\n'
    })
    fixtureRoot = fixture.root
    documentPath = fixture.documentPath
    const app = await attach(
      fixture.configDirectory,
      rendererEvents,
      this.timeout()
    )
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
  })

  after(async function () {
    await shutdown(browser, appProcess)
    if (documentPath !== undefined) {
      await chmod(documentPath, 0o600)
    }
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots
    )
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`)
    assertCleanExit(getOutput())
  })

  it('renders the contents of the active nonempty document', async function () {
    assert.ok(browser, 'The application must be running')
    const page = await findEditorPage(browser, this.timeout())
    const editor = page.locator('.cm-content')
    await editor.waitFor({
      state: 'visible',
      timeout: this.timeout(),
    })
    const diskDocument = await readFile(
      requireInitialized(documentPath, 'The document path must be initialized'),
      'utf8'
    )
    await page.waitForFunction(
      expected => {
        const content = document.querySelector('.cm-content')
        if (content === null) {
          return false
        }
        const tile = (
          content as HTMLElement & {
            cmTile?: {
              root?: {
                view?: { state?: { doc?: { toString(): string } } }
              }
            }
          }
        ).cmTile
        return tile?.root?.view?.state?.doc?.toString() === expected
      },
      diskDocument,
      { timeout: this.timeout() }
    )
    const renderedText = await editor.innerText()
    const editorDocument = await editor.evaluate(content => {
      const tile = (
        content as HTMLElement & {
          cmTile?: {
            root?: {
              view?: {
                state?: { doc?: { toString(): string } }
              }
            }
          }
        }
      ).cmTile
      const documentText = tile?.root?.view?.state?.doc?.toString()
      if (documentText === undefined) {
        throw new Error('Could not read the active CodeMirror document state')
      }
      return documentText
    })
    assert.equal(
      editorDocument,
      diskDocument,
      'The active CodeMirror document must exactly equal the bytes read from disk.'
    )
    assert.ok(
      renderedText.includes(MARKER),
      `The opened nonempty document rendered as an empty or incorrect buffer.\n` +
        `Rendered editor text: ${JSON.stringify(renderedText)}\n` +
        `Page URL: ${page.url()}\n` +
        `Application output:\n${outputTail(getOutput())}`
    )
    assert.deepEqual(
      rendererEvents,
      [],
      `The renderer reported unexpected errors or dialogs:\n${rendererEvents.join('\n')}`
    )
    screenshots.set('visible-document.png', await page.screenshot())
  })

  it('renders reference UI and opens a badge citing location on first load', async function () {
    assert.ok(browser, 'The application must be running')
    const activeDocumentPath = requireInitialized(
      documentPath,
      'The document path must be initialized'
    )
    const page = await findEditorPage(browser, this.timeout())
    const countBadge = page.locator(
      '.reference-count-badge[data-reference-key="sec:terminology"]'
    )

    await delay(5_000)
    screenshots.set('reference-badge-before-click.png', await page.screenshot())
    assert.equal(
      await countBadge.count(),
      1,
      `The real editor did not render the expected reference count badge.\n` +
        `Rendered editor text: ${JSON.stringify(await page.locator('.cm-content').innerText())}\n` +
        `Rendered badge keys: ${JSON.stringify(
          await page.locator('.reference-count-badge').evaluateAll(
            badges => badges.map(badge => (badge as HTMLElement).dataset.referenceKey)
          )
        )}`
    )
    await countBadge.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await countBadge.innerText(), '1 reference')
    await countBadge.click()

    const overlay = page.locator(
      '.reference-search-overlay[data-search-mode="citing-locations"]'
    )
    await overlay.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await overlay.locator('input[aria-label="Definition search query"]').inputValue(),
      'sec:terminology',
      'The badge key must survive the editor-to-overlay relay.'
    )
    const locations = overlay.locator('[data-occurrence-path]')
    assert.equal(
      await locations.count(),
      1,
      'The badge must open the one citing location counted by its label.'
    )
    assert.equal(
      await locations.first().getAttribute('data-occurrence-path'),
      activeDocumentPath
    )
    assert.match(
      await locations.first().innerText(),
      /@sec:terminology/
    )
    screenshots.set(
      'reference-badge-citing-location.png',
      await page.screenshot()
    )
    await locations.first().click()
    await overlay.waitFor({ state: 'hidden', timeout: 20_000 })
    const selectedSource = await page.locator('.cm-content').evaluate(content => {
      const tile = (
        content as HTMLElement & {
          cmTile?: {
            root?: {
              view?: {
                state?: {
                  doc?: { sliceString(from: number, to: number): string }
                  selection?: { main?: { from: number, to: number } }
                }
              }
            }
          }
        }
      ).cmTile
      const state = tile?.root?.view?.state
      const selection = state?.selection?.main
      if (state?.doc === undefined || selection === undefined) {
        throw new Error('Could not read the active CodeMirror selection')
      }
      return state.doc.sliceString(selection.from, selection.to)
    })
    assert.equal(
      selectedSource,
      '@sec:terminology',
      'Selecting the citing location must navigate to the exact authored occurrence.'
    )
  })

  it('attributes a remote reload failure to the active document', async function () {
    assert.ok(browser, 'The application must be running')
    const activeFixtureRoot = requireInitialized(
      fixtureRoot,
      'The fixture root must be initialized'
    )
    const activeDocumentPath = requireInitialized(
      documentPath,
      'The document path must be initialized'
    )
    const page = await findEditorPage(browser, this.timeout())

    await chmod(activeDocumentPath, 0o000)
    const changedAt = new Date(Date.now() + 60_000)
    await utimes(activeDocumentPath, changedAt, changedAt)

    const toast = page.locator('#zettlr-toast-container .zettlr-toast.error')
    await toast.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await toast.count(),
      1,
      'The remote reload failure must produce exactly one in-app error toast.'
    )
    assert.equal(
      await toast.getAttribute('role'),
      'status',
      'The reload failure must use the app toast status surface.'
    )
    const toastText = await toast.innerText()
    assert.ok(
      toastText.includes(path.basename(activeDocumentPath)) &&
        toastText.includes('EACCES'),
      `The error toast did not attribute the reload failure to the active document.\n` +
        `Toast text: ${JSON.stringify(toastText)}`
    )
    screenshots.set('document-reload-error-toast.png', await page.screenshot())

    const matchingDiagnostics = rendererEvents.filter(
      event =>
        event.includes(activeDocumentPath) && event.includes('EACCES')
    )
    assert.equal(
      matchingDiagnostics.length,
      1,
      `Renderer diagnostics did not identify the failed document.\n` +
        rendererEvents.join('\n')
    )
    await waitForAppDiagnostic(activeFixtureRoot, activeDocumentPath, 20_000)
  })
})

describe('cold-launch file delivery', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let documentPath: string | undefined
  let expectedContents: string | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createFixture('zettlr-cold-file-e2e-', {
      documentName: 'initial-document.md',
      documentContents: '# Initial document\n'
    })
    fixtureRoot = fixture.root
    documentPath = path.join(fixture.root, 'workspace', 'cold launch document.md')
    expectedContents =
      '# Cold launch\n\n' +
      'This exact buffer arrived through the application argv.\n'
    await writeFile(documentPath, expectedContents, 'utf8')

    const app = await attach(
      fixture.configDirectory,
      rendererEvents,
      this.timeout(),
      { files: [documentPath] }
    )
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
  })

  after(async function () {
    await shutdown(browser, appProcess)
    await preserveArtifacts(
      path.join(tmpdir(), 'zettlr-cold-file-e2e-latest'),
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots
    )
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    console.log('E2E artifacts: /tmp/zettlr-cold-file-e2e-latest')
    assertCleanExit(getOutput())
  })

  it('opens the requested file as the active editor with its exact contents', async function () {
    assert.ok(browser, 'The application must be running')
    const expected = requireInitialized(
      expectedContents,
      'The requested file contents must be initialized'
    )
    const page = await findEditorPage(browser, this.timeout())
    await waitForEditorDocument(page, expected, this.timeout())
    assert.equal(await readEditorDocument(page), expected)
    screenshots.set('cold-launch-document.png', await page.screenshot())
    assert.deepEqual(
      rendererEvents,
      [],
      `The renderer reported unexpected errors or dialogs:\n${rendererEvents.join('\n')}`
    )
  })
})

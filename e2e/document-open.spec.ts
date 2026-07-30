import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { chmod, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser } from 'playwright'
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
      documentContents: `# Opened document\n\n${MARKER}\n`
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
    const diskDocument = await readFile(
      requireInitialized(documentPath, 'The document path must be initialized'),
      'utf8'
    )

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

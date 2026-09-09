/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Search and replace e2e
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Replacing the matches of a workspace search (M10, D10):
 *                  all of them, one file's, or one match — an open document
 *                  changes in its editor, a closed one on disk, the results
 *                  refresh, and the last replace can be undone from the
 *                  Search view.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Page } from 'playwright'
import {
  assertCleanExit,
  attach,
  createWorkspaceFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  REPO_ROOT,
  requireInitialized,
  shutdown
} from './support/electron-app'

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-search-replace-e2e-latest')

const SEARCH_VIEW = '#navigation-sidebar[data-view="search"] #global-search-pane'
const QUERY_INPUT = `${SEARCH_VIEW} input >> nth=0`
const REPLACE_INPUT = `${SEARCH_VIEW} input[name="replace-input"]`
const ACTION = (name: 'replace-all' | 'replace-file' | 'replace-match' | 'undo-replace'): string => `[data-search-action="${name}"]`
const PANE_ACTION = (name: 'replace-all' | 'undo-replace'): string => `${SEARCH_VIEW} ${ACTION(name)}`
const RESULT = `${SEARCH_VIEW} .single-search-result`

const TERM = 'subgroupoid'
const REPLACEMENT = 'subcategory'

async function waitUntil (probe: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) {
      return
    }
    await delay(150)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function editorText (page: Page): Promise<string> {
  return await page.locator('.cm-content').innerText()
}

async function runSearch (page: Page, query: string): Promise<void> {
  await page.locator(QUERY_INPUT).fill(query)
  await page.locator(QUERY_INPUT).press('Enter')
  await waitUntil(async () => (await page.locator(`${SEARCH_VIEW} .search-result-container, ${SEARCH_VIEW} .search-no-results`).count()) > 0, 'the search to finish')
}

async function resultFiles (page: Page): Promise<string[]> {
  return await page.locator(`${RESULT} .result-header .filename`).allTextContents()
}

describe('search and replace across the workspace', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  const closedFile = (): string => path.join(requireInitialized(fixtureRoot, 'fixture root'), 'workspace', 'computation', 'sage.md')
  const openFile = (): string => path.join(requireInitialized(fixtureRoot, 'fixture root'), 'workspace', 'foundations', 'categories.md')

  before(async function () {
    // categories.md (open, the active document) and sage.md (closed) both
    // carry the term; sage.md carries it twice.
    const fixture = await createWorkspaceFixture('zettlr-search-replace-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: path.join('foundations', 'categories.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: false },
        ui: { sidebarView: 'search' }
      }
    })
    fixtureRoot = fixture.root
    configDirectory = fixture.configDirectory
    const app = await attach(requireInitialized(configDirectory, 'config directory'), rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    const editorPage = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(editorPage)
    await editorPage.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await editorPage.locator(SEARCH_VIEW).waitFor({ timeout: 60_000 })
    await editorPage.setViewportSize({ width: 1500, height: 950 })
    page = editorPage
  })

  after(async function () {
    await shutdown(browser, appProcess)
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixtureRoot, getOutput(), rendererEvents, screenshots)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`)
    assertCleanExit(getOutput())
  })

  it('replaces every match: the open document in its editor and on disk, the closed file on disk, and the results refresh', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    assert.match(await editorText(activePage), /subgroupoid/, 'the open document carries the term before the replace')
    await runSearch(activePage, TERM)
    assert.deepEqual((await resultFiles(activePage)).sort(), [ 'Sage', 'categories' ], 'both files match')
    await activePage.locator(REPLACE_INPUT).fill(REPLACEMENT)
    screenshots.set('before-replace-all.png', await activePage.screenshot())
    await activePage.locator(PANE_ACTION('replace-all')).click()
    await waitUntil(async () => /subcategory/.test(await editorText(activePage)) && !/subgroupoid/.test(await editorText(activePage)), 'the open document to change in its editor')
    await waitUntil(async () => {
      const text = await readFile(closedFile(), 'utf-8')
      return text.includes(REPLACEMENT) && !text.includes(TERM)
    }, 'the closed file to change on disk')
    await waitUntil(async () => (await readFile(openFile(), 'utf-8')).includes(REPLACEMENT), 'the open document to be saved with the replacement')
    await waitUntil(async () => (await activePage.locator(RESULT).count()) === 0, 'the results to refresh with no match left')
    screenshots.set('after-replace-all.png', await activePage.screenshot())
  })

  it('undoes the last replace in both places from the Search view', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(PANE_ACTION('undo-replace')).click()
    await waitUntil(async () => /subgroupoid/.test(await editorText(activePage)) && !/subcategory/.test(await editorText(activePage)), 'the open document to come back')
    await waitUntil(async () => {
      const text = await readFile(closedFile(), 'utf-8')
      return text.includes(TERM) && !text.includes(REPLACEMENT)
    }, 'the closed file to come back on disk')
    await waitUntil(async () => (await readFile(openFile(), 'utf-8')).includes(TERM), 'the open document to be saved with the term back')
    await runSearch(activePage, TERM)
    assert.deepEqual((await resultFiles(activePage)).sort(), [ 'Sage', 'categories' ], 'both files match again')
  })

  it('replaces one file\'s matches from its header and leaves the other file alone', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(REPLACE_INPUT).fill(REPLACEMENT)
    const sageResult = activePage.locator(RESULT).filter({ hasText: 'Sage' })
    await sageResult.locator(ACTION('replace-file')).click()
    await waitUntil(async () => {
      const text = await readFile(closedFile(), 'utf-8')
      return (text.match(/subcategory/g) ?? []).length === 2 && !text.includes(TERM)
    }, 'both matches of sage.md to change on disk')
    assert.match(await editorText(activePage), /subgroupoid/, 'the open document is untouched')
    await waitUntil(async () => (await resultFiles(activePage)).join() === 'categories', 'the results to refresh to the one file left')
    await activePage.locator(PANE_ACTION('undo-replace')).click()
    await waitUntil(async () => (await readFile(closedFile(), 'utf-8')).includes(TERM), 'sage.md to come back')
    await runSearch(activePage, TERM)
  })

  it('replaces a single match from its line and leaves the file\'s other match', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(REPLACE_INPUT).fill(REPLACEMENT)
    const sageResult = activePage.locator(RESULT).filter({ hasText: 'Sage' })
    await sageResult.locator(ACTION('replace-match')).first().click()
    await waitUntil(async () => {
      const text = await readFile(closedFile(), 'utf-8')
      return (text.match(/subcategory/g) ?? []).length === 1 && (text.match(/subgroupoid/g) ?? []).length === 1
    }, 'exactly one of sage.md\'s matches to change')
    await waitUntil(async () => (await resultFiles(activePage)).sort().join() === 'Sage,categories', 'the results to refresh with the remaining match')
    screenshots.set('after-replace-match.png', await activePage.screenshot())
  })
})

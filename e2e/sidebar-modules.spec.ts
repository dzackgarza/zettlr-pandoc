/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Left sidebar modules e2e (PLAN-left-sidebar-modules, M2)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the assembled app on a Quarto book workspace and
 *                  asserts the left sidebar is one column of modules: the
 *                  Book module lists parts and chapters and no heading row,
 *                  the Outline module lists the active document's headings,
 *                  "Search all files" reveals the Search module with its
 *                  query focused and a search yields results, a collapsed
 *                  module stays collapsed across a restart, and the old
 *                  Files/Book strip and the right sidebar's outline tab are
 *                  gone.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Page } from 'playwright'
import { parse as parseYaml } from 'yaml'
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-sidebar-modules-e2e-latest')

const SIDEBAR = '#navigation-sidebar'
const MODULE = (id: string): string => `${SIDEBAR} [data-module="${id}"]`
const MODULE_HEADER = (id: string): string => `${MODULE(id)} .chrome-section-trigger`

interface BookManifest {
  book: { chapters: Array<string | { part: string, chapters: string[] }> }
}

/** The chapter files and part titles the fixture's _quarto.yml declares, in order. */
async function readBookManifest (fixtureRoot: string): Promise<{ chapters: string[], parts: string[] }> {
  const manifest = parseYaml(await readFile(path.join(fixtureRoot, 'workspace', '_quarto.yml'), 'utf8')) as BookManifest
  const chapters: string[] = []
  const parts: string[] = []
  for (const entry of manifest.book.chapters) {
    if (typeof entry === 'string') {
      chapters.push(entry)
      continue
    }
    parts.push(entry.part)
    chapters.push(...entry.chapters)
  }
  return { chapters, parts }
}

async function readCollapsedModules (page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null || !('ui' in config)) {
      throw new Error('The config provider returned no ui section')
    }
    const ui: unknown = config.ui
    if (typeof ui !== 'object' || ui === null || !('sidebarCollapsedModules' in ui) || !Array.isArray(ui.sidebarCollapsedModules)) {
      throw new Error('The config provider returned no ui.sidebarCollapsedModules array')
    }
    return ui.sidebarCollapsedModules.filter((id): id is string => typeof id === 'string')
  })
}

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

describe('the left sidebar modules', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  async function launch (this: Mocha.Context): Promise<Page> {
    const app = await attach(requireInitialized(configDirectory, 'config directory'), rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    const editorPage = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(editorPage)
    await editorPage.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await editorPage.locator(MODULE('project')).waitFor({ timeout: 60_000 })
    return editorPage
  }

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-sidebar-modules-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: path.join('foundations', 'forms.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true, currentSidebarTab: 'references' }
      }
    })
    fixtureRoot = fixture.root
    configDirectory = fixture.configDirectory
    page = await launch.call(this)
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

  it('stacks Project, Search, Book and Outline as modules and carries no tab strip', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const ids = await activePage.locator(`${SIDEBAR} [data-module]`).evaluateAll(elements => elements.map(element => element.getAttribute('data-module')))
    assert.deepEqual(ids, [ 'project', 'search', 'book', 'outline' ], 'the modules stack in the plan order')
    assert.equal(await activePage.locator(`${SIDEBAR} .system-tablist`).count(), 0, 'the Files/Book strip is gone')
    assert.equal(await activePage.locator('#sidebar .system-tab[aria-controls="sidebar-toc"]').count(), 0, 'the right sidebar carries no outline tab')
    screenshots.set('sidebar-modules.png', await activePage.screenshot())
  })

  it('lists the book as parts and chapters only, with no heading rows', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const { chapters, parts } = await readBookManifest(requireInitialized(fixtureRoot, 'fixture'))
    const bookRows = activePage.locator(`${MODULE('book')} .quarto-book-outline button.chapter`)
    await waitUntil(async () => (await bookRows.count()) === chapters.length, `${chapters.length} chapter rows`)
    const partLabels = await activePage.locator(`${MODULE('book')} .quarto-book-outline .book-part h4`).allTextContents()
    assert.deepEqual(partLabels.map(label => label.trim()), parts, 'the parts appear with their titles')
    assert.equal(await activePage.locator(`${MODULE('book')} .book-sections`).count(), 0, 'no chapter lists its headings in the Book module')
    const activeChapter = activePage.locator(`${MODULE('book')} button.chapter.active`)
    assert.equal(await activeChapter.count(), 1, 'the active document is the one active chapter')
    assert.match(await activeChapter.innerText(), /Forms/)
  })

  it('lists the active document\'s headings in the Outline module alone', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const entries = activePage.locator(`${MODULE('outline')} .toc-entry-container`)
    await waitUntil(async () => (await entries.count()) === 1, 'the one heading of forms.md')
    assert.match(await entries.first().innerText(), /Forms/)
    assert.equal(await activePage.locator(`${SIDEBAR} .toc-entry-container`).count(), 1, 'headings appear in the Outline module and nowhere else in the sidebar')
    assert.equal(await activePage.locator(`${MODULE('outline')} h1`).count(), 0, 'the module header replaces the outline\'s own title')
  })

  it('reveals the Search module with its query focused on "Search all files", and a search yields results', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(MODULE_HEADER('search')).click()
    await activePage.locator(`${MODULE('search')}[data-state="closed"]`).waitFor({ timeout: 10_000 })

    await activePage.evaluate(() => {
      window.ipc.send('menu-provider', { command: 'click-menu-item', payload: 'menu.find_dir' })
    })
    await activePage.locator(`${MODULE('search')}[data-state="open"]`).waitFor({ timeout: 10_000 })
    const queryInput = activePage.locator(`${MODULE('search')} #global-search-pane input`).first()
    await waitUntil(async () => await queryInput.evaluate(element => element === document.activeElement), 'the search query to hold the focus')

    await activePage.keyboard.type('Lattice')
    await activePage.keyboard.press('Enter')
    const results = activePage.locator(`${MODULE('search')} .single-search-result`)
    await waitUntil(async () => (await results.count()) >= 1, 'at least one search result')
    screenshots.set('sidebar-search.png', await activePage.screenshot())
  })

  it('keeps a collapsed module collapsed across a restart', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(MODULE_HEADER('book')).click()
    await activePage.locator(`${MODULE('book')}[data-state="closed"]`).waitFor({ timeout: 10_000 })
    await waitUntil(async () => (await readCollapsedModules(activePage)).includes('book'), 'the collapsed set to persist book')

    await shutdown(browser, appProcess)
    page = await launch.call(this)
    const relaunched = requireInitialized(page, 'The editor page must be initialized')
    await relaunched.locator(`${MODULE('book')}[data-state="closed"]`).waitFor({ timeout: 60_000 })
    assert.equal(await relaunched.locator(`${MODULE('project')}[data-state="open"]`).count(), 1, 'Project stays expanded')
    assert.equal(await relaunched.locator(`${MODULE('outline')}[data-state="open"]`).count(), 1, 'Outline stays expanded')
    assert.deepEqual(await readCollapsedModules(relaunched), [ 'book' ])
    screenshots.set('sidebar-book-collapsed-after-restart.png', await relaunched.screenshot())
  })
})

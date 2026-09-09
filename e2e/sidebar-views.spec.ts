/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Sidebar views e2e
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The left pane as an activity bar of views (M9, D9): the
 *                  bar's three icons open one drawer on one view at a time,
 *                  the pressed icon closes it, the view and the collapsed
 *                  sections survive a relaunch; the Explorer lists the tree
 *                  (attachments included) with Outline and Book as sections
 *                  at its bottom; the References view lists the active
 *                  file's citations and related files; "Search all files"
 *                  opens the Search view with its query focused.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-sidebar-views-e2e-latest')

const BAR = '#activity-bar'
const ICON = (view: string): string => `${BAR} [data-activity="${view}"]`
const DRAWER = '#navigation-sidebar'
const VIEW = (view: string): string => `${DRAWER}[data-view="${view}"]`
const SECTION = (id: string): string => `${DRAWER} [data-section="${id}"]`
const SECTION_HEADER = (id: string): string => `${SECTION(id)} .chrome-section-trigger`

async function readConfig (page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null) {
      throw new Error('The config provider returned no config object')
    }
    return config as Record<string, unknown>
  })
}

function section (config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key]
  if (typeof value !== 'object' || value === null) {
    throw new Error(`The config carries no ${key} section`)
  }
  return value as Record<string, unknown>
}

async function clickMenuItem (page: Page, id: string): Promise<void> {
  await page.evaluate(itemId => {
    window.ipc.send('menu-provider', { command: 'click-menu-item', payload: itemId })
  }, id)
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

async function pressedIcons (page: Page): Promise<string[]> {
  return await page.locator(`${BAR} [data-activity][data-state="on"]`).evaluateAll(elements => elements.map(element => element.getAttribute('data-activity') ?? ''))
}

describe('the sidebar views', function () {
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
    await editorPage.locator(BAR).waitFor({ timeout: 60_000 })
    await editorPage.setViewportSize({ width: 1500, height: 950 })
    return editorPage
  }

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-sidebar-views-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: path.join('foundations', 'forms.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true }
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

  it('opens on the Explorer: the tree with an attachment, Outline and Book collapsed below it, and no other view', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const icons = await activePage.locator(`${BAR} [data-activity]`).evaluateAll(elements => elements.map(element => [ element.getAttribute('data-activity'), element.getAttribute('aria-label') ]))
    assert.deepEqual(icons, [ [ 'explorer', 'Explorer' ], [ 'search', 'Search' ], [ 'references', 'References' ] ], 'three icons, each named')
    assert.deepEqual(await pressedIcons(activePage), [ 'explorer' ], 'the Explorer is pressed')
    await activePage.locator(VIEW('explorer')).waitFor({ timeout: 10_000 })
    assert.equal(await activePage.locator(VIEW('search')).count() + await activePage.locator(VIEW('references')).count(), 0, 'no other view is shown')
    const sections = await activePage.locator(`${DRAWER} [data-section]`).evaluateAll(elements => elements.map(element => [ element.getAttribute('data-section'), element.getAttribute('data-state') ]))
    assert.deepEqual(sections, [ [ 'files', 'open' ], [ 'outline', 'closed' ], [ 'book', 'closed' ] ], 'Files open, Outline and Book collapsed at the bottom')
    await activePage.locator(`${SECTION('files')} #file-manager .tree-item[data-path$="/figure.png"]`).waitFor({ timeout: 10_000 })
    screenshots.set('explorer.png', await activePage.screenshot())
  })

  it('lists the book\'s chapters and the document\'s headings once their sections are expanded, and persists the collapsed set', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(SECTION_HEADER('book')).click()
    await activePage.locator(`${SECTION('book')}[data-state="open"]`).waitFor({ timeout: 10_000 })
    const chapters = activePage.locator(`${SECTION('book')} .quarto-book-outline button.chapter`)
    await waitUntil(async () => (await chapters.count()) === 4, 'the four chapters of the book')
    assert.equal(await activePage.locator(`${SECTION('book')} .book-sections`).count(), 0, 'no chapter lists its headings')
    await activePage.locator(SECTION_HEADER('outline')).click()
    await activePage.locator(`${SECTION('outline')}[data-state="open"]`).waitFor({ timeout: 10_000 })
    const headings = await activePage.locator(`${SECTION('outline')} .toc-entry-container`).allTextContents()
    assert.equal(headings.length, 1, 'forms.md has one heading')
    assert.match(headings[0], /Forms/)
    await waitUntil(async () => {
      const collapsed = section(await readConfig(activePage), 'ui').sidebarCollapsedSections
      return Array.isArray(collapsed) && !collapsed.includes('book') && !collapsed.includes('outline') && collapsed.includes('relatedFiles')
    }, 'the collapsed set to persist')
    await activePage.locator(SECTION_HEADER('book')).click()
    await activePage.locator(`${SECTION('book')}[data-state="closed"]`).waitFor({ timeout: 10_000 })
    screenshots.set('explorer-sections.png', await activePage.screenshot())
  })

  it('swaps to Search from its icon, remembers the view across a relaunch, and closes the drawer from the pressed icon', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(ICON('search')).click()
    await activePage.locator(VIEW('search')).waitFor({ timeout: 10_000 })
    assert.equal(await activePage.locator(VIEW('explorer')).count(), 0, 'the Explorer left the drawer')
    assert.deepEqual(await pressedIcons(activePage), [ 'search' ])
    await waitUntil(async () => section(await readConfig(activePage), 'ui').sidebarView === 'search', 'the view to persist')
    screenshots.set('search-view.png', await activePage.screenshot())

    await shutdown(browser, appProcess)
    page = await launch.call(this)
    const relaunched = requireInitialized(page, 'The editor page must be initialized')
    await relaunched.locator(VIEW('search')).waitFor({ timeout: 10_000 })
    assert.deepEqual(await pressedIcons(relaunched), [ 'search' ], 'the Search view comes back pressed')
    const collapsed = section(await readConfig(relaunched), 'ui').sidebarCollapsedSections
    assert.ok(Array.isArray(collapsed) && collapsed.includes('book') && !collapsed.includes('outline'), `the collapsed set came back: ${JSON.stringify(collapsed)}`)

    await relaunched.locator(ICON('search')).click()
    await relaunched.locator(DRAWER).waitFor({ state: 'detached', timeout: 10_000 })
    assert.deepEqual(await pressedIcons(relaunched), [], 'no icon is pressed while the drawer is closed')
    await waitUntil(async () => section(await readConfig(relaunched), 'window').fileManagerVisible === false, 'the drawer state to persist')
    screenshots.set('drawer-closed.png', await relaunched.screenshot())
    await relaunched.locator(ICON('explorer')).click()
    await relaunched.locator(VIEW('explorer')).waitFor({ timeout: 10_000 })
  })

  it('opens the Search view with its query focused on "Search all files", and a search yields results', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator('.cm-content').click()
    await clickMenuItem(activePage, 'menu.find_dir')
    await activePage.locator(VIEW('search')).waitFor({ timeout: 10_000 })
    const queryInput = activePage.locator(`${VIEW('search')} #global-search-pane input`).first()
    await waitUntil(async () => await queryInput.evaluate(element => element === document.activeElement), 'the query input to take the focus')
    await queryInput.fill('lattice')
    await queryInput.press('Enter')
    const results = activePage.locator(`${VIEW('search')} .single-search-result`)
    await waitUntil(async () => (await results.count()) >= 1, 'search results')
    screenshots.set('search-results.png', await activePage.screenshot())
  })

  it('lists the active file\'s citations and its related files in the References view', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(ICON('explorer')).click()
    await activePage.locator(`${SECTION('files')} #file-manager .tree-item.file[data-path$="/index.md"]`).click()
    await activePage.locator(ICON('references')).click()
    await activePage.locator(VIEW('references')).waitFor({ timeout: 10_000 })
    const sections = await activePage.locator(`${DRAWER} [data-section]`).evaluateAll(elements => elements.map(element => [ element.getAttribute('data-section'), element.getAttribute('data-state') ]))
    assert.deepEqual(sections, [ [ 'citations', 'open' ], [ 'relatedFiles', 'closed' ] ], 'citations open, related files collapsed below')
    const entries = activePage.locator(`${SECTION('citations')} #references-list .csl-entry`)
    await waitUntil(async () => (await entries.count()) === 1, 'the one citation of index.md')
    assert.match(await entries.first().innerText(), /Mac Lane/)
    await activePage.locator(SECTION_HEADER('relatedFiles')).click()
    await activePage.locator(`${SECTION('relatedFiles')}[data-state="open"] .related-files-panel`).waitFor({ timeout: 10_000 })
    screenshots.set('references-view.png', await activePage.screenshot())
  })
})

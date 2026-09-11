/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Bound Quarto book e2e
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace whose Quarto manifest lives in an assembly
 *                  directory beside the prose it renders. The directory's
 *                  properties bind the workspace to that manifest; the Book
 *                  module then lists the book in manifest order and opens each
 *                  chapter at the real file the assembly's symlink reaches,
 *                  while .ztr-directory holds the binding and nothing the
 *                  manifest says.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-quarto-bound-book-e2e-latest')

const DRAWER = '#navigation-sidebar'
const SECTION = (id: string): string => `${DRAWER} [data-section="${id}"]`
const SECTION_HEADER = (id: string): string => `${SECTION(id)} .chrome-section-trigger`
const CHAPTER = `${SECTION('book')} .quarto-book-outline button.chapter`
const POPOVER = '#dir-props'
const MANIFEST_FIELD = `${POPOVER} #field-input-quarto-manifest`
const BINDING = path.join('.book', '_quarto.yml')

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

describe('a workspace bound to the manifest in its assembly directory', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let workspace: string | undefined
  let configDirectory: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  /** Opens the workspace root's properties through the directory's own context menu. */
  async function openDirectoryProperties (activePage: Page): Promise<void> {
    const root = activePage.locator(`.tree-item.directory[data-path=${JSON.stringify(requireInitialized(workspace, 'workspace'))}]`)
    await root.waitFor({ state: 'visible', timeout: 30_000 })
    await root.click({ button: 'right' })
    const properties = activePage.locator('.application-menu .menu-item[data-id="menu.properties"]')
    await properties.waitFor({ state: 'visible', timeout: 10_000 })
    await properties.click()
    await activePage.locator(POPOVER).waitFor({ state: 'visible', timeout: 10_000 })
  }

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-quarto-bound-book-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-bound-book'),
      activeDocument: path.join('category-theory', 'framework', 'Bilinear-and-Quadratic-Forms.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true }
      }
    })
    fixtureRoot = fixture.root
    workspace = path.join(fixture.root, 'workspace')
    configDirectory = fixture.configDirectory
    const app = await attach(requireInitialized(configDirectory, 'config directory'), rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    page = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(page)
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await page.setViewportSize({ width: 1500, height: 950 })
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

  it('is no book until it is bound: the manifest sits in a directory the workspace does not show', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(`${SECTION('files')} #file-manager`).waitFor({ timeout: 30_000 })
    assert.equal(
      await activePage.locator(`${SECTION('files')} #file-manager .tree-item[data-path$="/.book"]`).count(),
      0,
      'the assembly directory is a dotted directory, so the file manager never shows it'
    )
    assert.equal(await activePage.locator(SECTION('book')).count(), 0, 'no Book module, since nothing says where the manifest is')
    screenshots.set('unbound.png', await activePage.screenshot())
  })

  it('binds from the directory properties, and writes the binding alone to .ztr-directory', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const root = requireInitialized(workspace, 'workspace')
    await openDirectoryProperties(activePage)
    screenshots.set('properties-unbound.png', await activePage.screenshot())

    await activePage.locator(MANIFEST_FIELD).fill(BINDING)
    await activePage.locator(MANIFEST_FIELD).press('Enter')

    await activePage.locator(POPOVER).getByText(`Quarto project settings: ${BINDING}`).waitFor({ timeout: 10_000 })
    await activePage.locator(`${POPOVER} #unbind-quarto-manifest`).waitFor({ state: 'visible', timeout: 10_000 })
    screenshots.set('properties-bound.png', await activePage.screenshot())

    const settings: unknown = JSON.parse(await readFile(path.join(root, '.ztr-directory'), 'utf8'))
    assert.deepEqual(
      settings,
      { sorting: 'name-up', project: null, icon: null, color: null, quartoManifest: BINDING },
      'the workspace records where its manifest is, and nothing the manifest says'
    )
  })

  it('lists the bound book in manifest order, naming each chapter by the file it really is', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.keyboard.press('Escape')
    await activePage.locator(SECTION('book')).waitFor({ state: 'visible', timeout: 20_000 })
    await activePage.locator(SECTION_HEADER('book')).click()
    await activePage.locator(`${SECTION('book')}[data-state="open"]`).waitFor({ timeout: 10_000 })
    await waitUntil(async () => (await activePage.locator(CHAPTER).count()) === 3, 'the three chapters of the bound book')

    assert.deepEqual(
      await activePage.locator(`${SECTION('book')} .quarto-book-outline .chrome-row-label`).allTextContents(),
      [ 'Writing', 'Bilinear and quadratic forms', 'The Coble lattice table' ],
      'the manifest order, titled from the real files the assembly links to'
    )
    assert.deepEqual(
      await activePage.locator(`${SECTION('book')} .book-part .chrome-group-label`).allTextContents(),
      [ 'Category theory', 'Coble surfaces' ],
      'the manifest owns the parts'
    )
    screenshots.set('book-module.png', await activePage.screenshot())
  })

  it('opens a chapter at the file the symlink beside the manifest reaches', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const root = requireInitialized(workspace, 'workspace')
    const chapter = path.join(root, 'coble', 'lattices-and-moduli', 'coble-lattice-table.md')

    await activePage.locator(CHAPTER).filter({ hasText: 'The Coble lattice table' }).click()

    await activePage.locator(`.document-tablist-wrapper [data-path=${JSON.stringify(chapter)}]`)
      .waitFor({ timeout: 20_000 })
    assert.equal(
      await activePage.locator(`.document-tablist-wrapper [data-path*="/.book/"]`).count(),
      0,
      'no chapter reached the editor through the assembly directory'
    )
    screenshots.set('chapter-open.png', await activePage.screenshot())
  })

  it('gives the book up again when the workspace is unbound', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const root = requireInitialized(workspace, 'workspace')
    await openDirectoryProperties(activePage)

    await activePage.locator(`${POPOVER} #unbind-quarto-manifest`).click()

    await waitUntil(async () => (await activePage.locator(SECTION('book')).count()) === 0, 'the Book module to go')
    await waitUntil(async () => !existsSync(path.join(root, '.ztr-directory')), 'the settings file to go with the binding')
    screenshots.set('unbound-again.png', await activePage.screenshot())
  })
})

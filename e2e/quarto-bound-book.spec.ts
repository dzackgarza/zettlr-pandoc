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
import type { DirectorySettings } from '@dts/common/fsal'
import type { ConfigOptions } from '@providers/config/get-config-template'
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

  /** Chooses one leaf from a top-level Workspaces … submenu. */
  async function chooseExplorerMenuItem (activePage: Page, submenuId: string, itemId: string): Promise<void> {
    await activePage.locator('#directories-dirs-header .root-settings').click()
    const submenu = activePage.locator(`.application-menu .menu-item[data-id=${JSON.stringify(submenuId)}]`).last()
    await submenu.waitFor({ state: 'visible', timeout: 10_000 })
    await submenu.hover()
    const item = activePage.locator(`.application-menu .menu-item[data-id=${JSON.stringify(itemId)}]`).last()
    await item.waitFor({ state: 'visible', timeout: 10_000 })
    await item.click()
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

    await activePage.locator(POPOVER).getByText(`Quarto book: ${BINDING}`).waitFor({ timeout: 10_000 })
    await activePage.locator(`${POPOVER} #unbind-quarto-manifest`).waitFor({ state: 'visible', timeout: 10_000 })
    screenshots.set('properties-bound.png', await activePage.screenshot())

    const settings: unknown = JSON.parse(await readFile(path.join(root, '.ztr-directory'), 'utf8'))
    assert.deepEqual(
      settings,
      {
        sorting: 'name-up',
        explorer: {
          displayName: 'inherit',
          sortMetadataKey: 'zettlr-order_',
          foldersFirst: null,
          projectFilter: 'all'
        },
        project: null,
        icon: null,
        color: null,
        quartoManifest: BINDING
      },
      'the workspace records where its manifest is, and nothing the manifest says'
    )
  })

  it('makes nested book membership and project-wide Explorer ordering visible', async function () {
    let activePage = requireInitialized(page, 'The editor page must be initialized')
    const root = requireInitialized(workspace, 'workspace')
    await activePage.keyboard.press('Escape')

    const included = path.join(root, 'category-theory', 'framework', 'Bilinear-and-Quadratic-Forms.md')
    const omitted = path.join(root, 'category-theory', 'index.md')
    const includedRow = activePage.locator(`.tree-item[data-path=${JSON.stringify(included)}]`)
    const omittedRow = activePage.locator(`.tree-item[data-path=${JSON.stringify(omitted)}]`)
    await includedRow.waitFor({ state: 'visible', timeout: 20_000 })
    await omittedRow.waitFor({ state: 'visible', timeout: 20_000 })
    const includedMembership = includedRow.locator('.project-membership.included.quarto')
    const omittedMembership = omittedRow.locator('.project-membership.omitted.quarto')
    const includedTitle = await includedMembership.getAttribute('title')
    const omittedTitle = await omittedMembership.getAttribute('title')
    assert.ok(includedTitle !== null, 'the included chapter badge must explain its membership')
    assert.ok(omittedTitle !== null, 'the omitted file badge must explain its membership')
    assert.match(includedTitle, /Book chapter 2/)
    assert.match(omittedTitle, /not included in the Quarto book/i)
    assert.equal(await includedMembership.locator('cds-icon').getAttribute('shape'), 'book')
    assert.equal(await includedMembership.locator('.membership-position').textContent(), '2')
    assert.equal(await omittedMembership.locator('cds-icon').getAttribute('shape'), 'book')
    assert.equal(await omittedMembership.locator('.membership-position').count(), 0)

    await activePage.locator('#directories-dirs-header .root-settings').click()
    assert.equal(
      await activePage.locator('.application-menu .menu-item[data-id="explorer-view"]').count(),
      0,
      'Explorer controls are direct Workspaces menu entries, not hidden behind another submenu'
    )
    await activePage.keyboard.press('Escape')

    assert.equal(
      await activePage.locator('[data-explorer-control]').count(),
      0,
      'Explorer view controls belong in the existing Workspaces ellipsis menu, not a permanent dropdown strip'
    )

    const workspaceHeaderStyle = await activePage.locator('#directories-dirs-header').evaluate(element => {
      const style = getComputedStyle(element)
      return { position: style.position, top: style.top }
    })
    assert.deepEqual(workspaceHeaderStyle, { position: 'sticky', top: '0px' }, 'the Workspaces control bar stays pinned while its tree scrolls')

    const workspaceRowTop = await activePage.locator(`.tree-item.directory.root[data-path=${JSON.stringify(root)}]`)
      .evaluate(element => getComputedStyle(element).top)
    assert.equal(workspaceRowTop, '28px', 'sticky directory rows reserve the Workspaces bar above them')

    // Choose non-default values across every persistent Explorer preference.
    await chooseExplorerMenuItem(activePage, 'explorer-display', 'explorer-display-filename')
    await chooseExplorerMenuItem(activePage, 'explorer-sort', 'explorer-sort-filename')
    await chooseExplorerMenuItem(activePage, 'explorer-direction', 'explorer-direction-down')
    await chooseExplorerMenuItem(activePage, 'explorer-grouping', 'explorer-grouping-mixed')
    await chooseExplorerMenuItem(activePage, 'explorer-project-files', 'explorer-project-omitted')
    await omittedRow.waitFor({ state: 'visible', timeout: 10_000 })
    await includedRow.waitFor({ state: 'hidden', timeout: 10_000 })

    // Expand an unrelated branch too; unlike the active document's ancestors,
    // nothing else will reconstruct this expansion automatically after restart.
    const coblePath = path.join(root, 'coble')
    const cobleRow = activePage.locator(`.tree-item.directory[data-path=${JSON.stringify(coblePath)}]`)
    await cobleRow.locator('.item-icon').click()
    const cobleChild = activePage.locator(`.tree-item[data-path^=${JSON.stringify(`${coblePath}${path.sep}`)}]`).first()
    await cobleChild.waitFor({ state: 'visible', timeout: 10_000 })

    await waitUntil(async () => {
      // The binding step above already made the app write these settings.
      const settings: DirectorySettings = JSON.parse(await readFile(path.join(root, '.ztr-directory'), 'utf8'))
      return settings.sorting === 'filename-down' &&
        settings.explorer.displayName === 'filename' &&
        settings.explorer.foldersFirst === false &&
        settings.explorer.projectFilter === 'omitted'
    }, 'all Explorer view preferences to reach .ztr-directory')

    await waitUntil(async () => {
      // Until the app first persists its configuration, config.json holds only
      // the keys the fixture wrote, and those carry no fileManager group.
      const config: ConfigOptions | { fileManager?: undefined } = JSON.parse(await readFile(path.join(requireInitialized(configDirectory, 'config directory'), 'config.json'), 'utf8'))
      if (config.fileManager === undefined) {
        return false
      }
      return config.fileManager.expandedDirectories.includes(coblePath)
    }, 'expanded Explorer folders to reach persistent app config')

    // Relaunch against the same profile and workspace. The non-default view
    // should come back before we touch any Explorer controls.
    await shutdown(browser, appProcess)
    const restarted = await attach(requireInitialized(configDirectory, 'config directory'), rendererEvents, this.timeout())
    appProcess = restarted.appProcess
    browser = restarted.browser
    getOutput = restarted.getOutput
    page = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(page)
    activePage = requireInitialized(page, 'The relaunched editor page must be initialized')
    await activePage.setViewportSize({ width: 1500, height: 950 })

    const restartedOmittedRow = activePage.locator(`.tree-item[data-path=${JSON.stringify(omitted)}]`)
    const restartedIncludedRow = activePage.locator(`.tree-item[data-path=${JSON.stringify(included)}]`)
    await restartedOmittedRow.waitFor({ state: 'visible', timeout: 20_000 })
    await restartedIncludedRow.waitFor({ state: 'hidden', timeout: 20_000 })
    await activePage.locator(`.tree-item[data-path^=${JSON.stringify(`${coblePath}${path.sep}`)}]`).first()
      .waitFor({ state: 'visible', timeout: 20_000 })

    for (const [ submenuId, itemId ] of [
      [ 'explorer-display', 'explorer-display-filename' ],
      [ 'explorer-sort', 'explorer-sort-filename' ],
      [ 'explorer-direction', 'explorer-direction-down' ],
      [ 'explorer-grouping', 'explorer-grouping-mixed' ],
      [ 'explorer-project-files', 'explorer-project-omitted' ]
    ] as const) {
      await activePage.locator('#directories-dirs-header .root-settings').click()
      const submenu = activePage.locator(`.application-menu .menu-item[data-id=${JSON.stringify(submenuId)}]`).last()
      await submenu.hover()
      const chosen = activePage.locator(`.application-menu .menu-item[data-id=${JSON.stringify(itemId)}]`).last()
      await chosen.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await chosen.locator('.status cds-icon[shape="dot-circle"]').count(), 1, `${itemId} remains selected after restart`)
      await activePage.keyboard.press('Escape')
    }

    // Reset the view so later tests also prove the default state remains
    // round-trippable and unbinding can remove the otherwise-default dotfile.
    await chooseExplorerMenuItem(activePage, 'explorer-project-files', 'explorer-project-all')
    await chooseExplorerMenuItem(activePage, 'explorer-display', 'explorer-display-inherit')
    await chooseExplorerMenuItem(activePage, 'explorer-sort', 'explorer-sort-display')
    await chooseExplorerMenuItem(activePage, 'explorer-direction', 'explorer-direction-up')
    await chooseExplorerMenuItem(activePage, 'explorer-grouping', 'explorer-grouping-inherit')
    await restartedIncludedRow.waitFor({ state: 'visible', timeout: 10_000 })
    screenshots.set('project-aware-explorer.png', await activePage.screenshot())
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

  it('edits the authoritative book from the UI: add, drag out of a part, create a part, and create a chapter', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const root = requireInitialized(workspace, 'workspace')
    const manifestPath = path.join(root, BINDING)

    await activePage.locator(`${SECTION('book')} .manage-book`).click()
    const omittedControl = activePage.locator(`${SECTION('book')} [data-book-control="omitted-chapter"]`)
    await omittedControl.selectOption('category-theory/index.md')
    await activePage.locator(`${SECTION('book')} [data-book-action="add-chapter"]`).click()
    await waitUntil(async () => (await activePage.locator(CHAPTER).count()) === 4, 'the omitted category-theory index to join the book')
    assert.deepEqual(
      await activePage.locator(`${SECTION('book')} .quarto-book-outline .chrome-row-label`).allTextContents(),
      [ 'Writing', 'Bilinear and quadratic forms', 'Category theory', 'The Coble lattice table' ],
      'adding after the active nested chapter keeps the chapter in that part'
    )

    // Drag the newly included chapter before the top-level landing chapter.
    // This crosses a part boundary and therefore proves the drop operation is
    // editing the manifest structure, not merely shuffling rendered rows.
    const categoryChapter = activePage.locator(CHAPTER).filter({ hasText: 'Category theory' })
    const writingChapter = activePage.locator(CHAPTER).filter({ hasText: 'Writing' })
    await categoryChapter.dragTo(writingChapter)
    await waitUntil(async () => {
      const labels = await activePage.locator(`${SECTION('book')} .quarto-book-outline .chrome-row-label`).allTextContents()
      return labels[0] === 'Category theory'
    }, 'the dragged chapter to move out of its part')

    const partTitle = activePage.locator(`${SECTION('book')} [data-book-control="new-part-title"]`)
    const partChapter = activePage.locator(`${SECTION('book')} [data-book-control="part-chapter"]`)
    await partTitle.fill('Surface appendix')
    await partChapter.selectOption('coble/index.md')
    await activePage.locator(`${SECTION('book')} [data-book-action="add-part"]`).click()
    await activePage.locator(`${SECTION('book')} .book-part .chrome-group-label`).filter({ hasText: 'Surface appendix' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    await activePage.locator(CHAPTER).filter({ hasText: 'Coble surfaces' }).waitFor({ state: 'visible', timeout: 10_000 })

    const newChapter = activePage.locator(`${SECTION('book')} [data-book-control="new-chapter-name"]`)
    await activePage.locator(`${SECTION('book')} [data-book-control="new-chapter-placement"]`).selectOption('book-end')
    await newChapter.fill('New-Section.md')
    await activePage.locator(`${SECTION('book')} [data-book-action="new-chapter"]`).click()
    const created = path.join(root, 'category-theory', 'framework', 'New-Section.md')
    await waitUntil(async () => existsSync(created), 'the new book chapter file to be created')
    await activePage.locator(CHAPTER).filter({ hasText: 'New-Section.md' }).waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(
      (await activePage.locator(`${SECTION('book')} .quarto-book-outline .chrome-row-label`).allTextContents()).at(-1),
      'New-Section.md',
      'the placement selector can put a newly created chapter at top-level book end'
    )

    const manifest = await readFile(manifestPath, 'utf8')
    assert.match(manifest, /category-theory\/index\.md/, 'the added chapter uses the assembly symlink route')
    assert.doesNotMatch(manifest, /\.\.\/category-theory\/index\.md/, 'the editor never escapes the bound Quarto project')
    assert.match(manifest, /part: Surface appendix/)
    assert.match(manifest, /category-theory\/framework\/New-Section\.md/)
    screenshots.set('book-authoring.png', await activePage.screenshot())
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

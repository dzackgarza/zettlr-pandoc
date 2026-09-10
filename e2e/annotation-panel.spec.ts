/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation panel pane e2e (PLAN-main-window-chrome-convergence, M5)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the assembled app on a Quarto book workspace and
 *                  asserts  *                  are modules of the left sidebar after Outline, that the
 *                  References module lists the active document's citations,
 *                  that the right pane holds the annotation review panel
 *                  and nothing else, and that hiding the panel through its
 *                  View menu item keeps it hidden across a restart.
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-annotation-panel-e2e-latest')

const SIDEBAR = '#navigation-sidebar'
const SECTION = (id: string): string => `${SIDEBAR} [data-section="${id}"]`
const PANEL = '#annotations-panel'

async function readPanelVisible (page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null || !('window' in config)) {
      throw new Error('The config provider returned no window section')
    }
    const window_: unknown = config.window
    if (typeof window_ !== 'object' || window_ === null || !('sidebarVisible' in window_) || typeof window_.sidebarVisible !== 'boolean') {
      throw new Error('The config provider returned no window.sidebarVisible boolean')
    }
    return window_.sidebarVisible
  })
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

describe('the annotation review panel pane', function () {
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
    await editorPage.locator(SECTION('files')).waitFor({ timeout: 60_000 })
    // A working-size window: the modules share the pane's height, and the
    // tree rows this spec clicks need room below the Project module's filter.
    await editorPage.setViewportSize({ width: 1500, height: 950 })
    return editorPage
  }

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-annotation-panel-e2e-', {
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

  it('lists the active document\'s citations in the References view', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    // index.md cites Mac98 from references.bib; opening it fills the
    // References view's Citations section.
    await activePage.locator(`${SIDEBAR} [data-section="files"] .tree-item.file[data-path$="/index.md"]`).click()
    await activePage.locator('#activity-bar [data-activity="references"]').click()
    await activePage.locator(`${SIDEBAR}[data-view="references"]`).waitFor({ timeout: 10_000 })
    const sections = await activePage.locator(`${SIDEBAR} [data-section]`).evaluateAll(elements => elements.map(element => element.getAttribute('data-section')))
    assert.deepEqual(sections, [ 'citations', 'relatedFiles' ], 'the References view stacks citations over related files')
    const entries = activePage.locator(`${SIDEBAR} [data-section="citations"] #references-list .csl-entry`)
    await waitUntil(async () => (await entries.count()) === 1, 'the one citation of index.md in the Citations section')
    assert.match(await entries.first().innerText(), /Mac Lane/)
    assert.equal(await activePage.locator(`${SIDEBAR} h1, ${SIDEBAR} h2`).count(), 0, 'no section body carries its own title')
    screenshots.set('references-view.png', await activePage.screenshot())
    await activePage.locator('#activity-bar [data-activity="explorer"]').click()
    await activePage.locator(`${SIDEBAR}[data-view="explorer"]`).waitFor({ timeout: 10_000 })
  })

  it('holds the annotation review panel alone in the right pane, with no tab strip', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const panel = activePage.locator(PANEL)
    await panel.waitFor({ state: 'attached', timeout: 10_000 })
    const pane = await panel.evaluate(element => {
      const parent = element.parentElement
      return {
        isSplitView: parent !== null && parent.getAttribute('data-pane') === 'annotation-panel',
        siblingCount: parent === null ? -1 : parent.children.length
      }
    })
    assert.equal(pane.isSplitView, true, 'the panel is the direct child of the split view\'s pane')
    assert.equal(pane.siblingCount, 1, 'the pane holds the panel and nothing else')
    assert.equal(await activePage.locator('.system-tablist').count(), 0, 'no tab strip exists anywhere in the window')
  })

  it('hides the panel through its View menu item and keeps it hidden across a restart', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await clickMenuItem(activePage, 'menu.toggle_annotation_panel')
    await activePage.locator(PANEL).waitFor({ state: 'hidden', timeout: 10_000 })
    await waitUntil(async () => !(await readPanelVisible(activePage)), 'the panel visibility to persist as hidden')

    await shutdown(browser, appProcess)
    page = await launch.call(this)
    const relaunched = requireInitialized(page, 'The editor page must be initialized')
    assert.equal(await relaunched.locator(PANEL).isVisible(), false, 'the panel stays hidden after the restart')
    assert.equal(await readPanelVisible(relaunched), false)

    await clickMenuItem(relaunched, 'menu.toggle_annotation_panel')
    await relaunched.locator(PANEL).waitFor({ state: 'visible', timeout: 10_000 })
    await waitUntil(async () => await readPanelVisible(relaunched), 'the panel visibility to persist as shown')
    screenshots.set('panel-after-restart.png', await relaunched.screenshot())
  })

  it('opens the panel on the annotation from its gutter chip', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    // index.md reads `# Lattice Notes`: the annotation targets "Lattice".
    // Opening it from the tree makes it the active, loaded document.
    await activePage.locator(`${SIDEBAR} [data-section="files"] .tree-item.file[data-path$="/index.md"]`).click()
    await waitUntil(async () => /Lattice/.test(await activePage.locator('.cm-content').innerText()), 'index.md to be the active document')
    await clickMenuItem(activePage, 'menu.toggle_annotation_panel')
    await activePage.locator(PANEL).waitFor({ state: 'hidden', timeout: 10_000 })

    const documentPath = path.join(requireInitialized(fixtureRoot, 'fixture root'), 'workspace', 'index.md')
    const created = await activePage.evaluate(async pathInPage => await window.ipc.invoke('documents:create-annotation', {
      path: pathInPage, from: 2, to: 9, instruction: 'Say which lattices these are', expectedAnnotationGeneration: 0
    }), documentPath)
    assert.ok(typeof created === 'object' && created !== null && 'annotationId' in created, `the annotation was created: ${JSON.stringify(created)}`)

    const chip = activePage.locator('.cm-textAnnotation-gutterMarker')
    await chip.waitFor({ state: 'visible', timeout: 10_000 })
    await chip.click()
    await activePage.locator(PANEL).waitFor({ state: 'visible', timeout: 10_000 })
    await waitUntil(async () => await readPanelVisible(activePage), 'the panel visibility to persist as shown')
    const detail = activePage.locator(`${PANEL} [data-annotation-detail]`)
    await detail.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await detail.innerText(), /Say which lattices these are/, 'the chip\'s annotation is the one opened')
    await waitUntil(async () => (await activePage.locator('.cm-textAnnotation-gutterMarker-active').count()) === 1, 'the chip to show as active')
    screenshots.set('panel-from-chip.png', await activePage.screenshot())
  })

  it('deletes the selected annotation from the panel', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(`${PANEL} [data-annotation-detail] [data-annotation-action="delete"]`).click()
    await waitUntil(async () => (await activePage.locator('.cm-textAnnotation-gutterMarker').count()) === 0, 'the chip to leave the editor')
    await waitUntil(async () => (await activePage.locator(`${PANEL} .annotation-list-item`).count()) === 0, 'the card to leave the list')
    assert.equal(await activePage.locator(`${PANEL} [data-annotation-detail]`).count(), 0, 'the detail closes with its annotation')
    screenshots.set('panel-after-delete.png', await activePage.screenshot())
  })
})

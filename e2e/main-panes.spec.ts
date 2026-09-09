/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Main window panes e2e
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The three panes of the main window — the navigation
 *                  sidebar, the editor and the annotation review panel —
 *                  under the one splitter that owns them (D8): a dragged
 *                  pane keeps its width in pixels across a relaunch at
 *                  another window width, a narrow window holds the panel at
 *                  its minimum instead of squeezing it, and a hidden pane
 *                  takes its handle with it and hands its width to the
 *                  editor.
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-main-panes-e2e-latest')

const PANE = (name: 'navigation-sidebar' | 'editor' | 'annotation-panel'): string => `[data-pane="${name}"]`
const HANDLE = (name: 'navigation-sidebar' | 'annotation-panel'): string => `[data-pane-handle="${name}"]`
const TOGGLE = (name: 'navigation-sidebar' | 'annotation-panel'): string => `.document-tablist-wrapper [data-pane-toggle="${name}"]`

const ANNOTATION_PANEL_MINIMUM = 240

async function paneWidth (page: Page, name: 'navigation-sidebar' | 'editor' | 'annotation-panel'): Promise<number> {
  const box = await page.locator(PANE(name)).boundingBox()
  assert.ok(box !== null, `the ${name} pane is laid out`)
  return box.width
}

async function readUiConfig (page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null) {
      throw new Error('The config provider returned no config object')
    }
    const ui: unknown = (config as Record<string, unknown>).ui
    if (typeof ui !== 'object' || ui === null) {
      throw new Error('The config carries no ui section')
    }
    return ui as Record<string, unknown>
  })
}

async function dragHandle (page: Page, name: 'navigation-sidebar' | 'annotation-panel', dx: number): Promise<void> {
  const box = await page.locator(HANDLE(name)).boundingBox()
  assert.ok(box !== null, `the ${name} handle is laid out`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 6 })
  await page.mouse.move(x + dx, y, { steps: 6 })
  await page.mouse.up()
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

describe('the main window panes', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  async function launch (this: Mocha.Context, width: number, height: number): Promise<Page> {
    const app = await attach(requireInitialized(configDirectory, 'config directory'), rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    const editorPage = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(editorPage)
    await editorPage.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await editorPage.locator('#navigation-sidebar [data-module="project"]').waitFor({ timeout: 60_000 })
    await editorPage.setViewportSize({ width, height })
    await editorPage.waitForFunction(expected => window.innerWidth === expected, width, { timeout: 10_000 })
    return editorPage
  }

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-main-panes-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: path.join('foundations', 'forms.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true }
      }
    })
    fixtureRoot = fixture.root
    configDirectory = fixture.configDirectory
    page = await launch.call(this, 1500, 950)
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

  it('keeps a dragged sidebar width in pixels across a relaunch at another window width', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const before = await paneWidth(activePage, 'navigation-sidebar')
    await dragHandle(activePage, 'navigation-sidebar', 120)
    const dragged = await paneWidth(activePage, 'navigation-sidebar')
    assert.ok(Math.abs(dragged - (before + 120)) <= 8, `the sidebar follows the handle: ${before} -> ${dragged}`)
    await waitUntil(async () => {
      const width = (await readUiConfig(activePage)).navigationSidebarWidth
      return typeof width === 'number' && Math.abs(width - dragged) <= 8
    }, 'the dragged width to persist as ui.navigationSidebarWidth')
    screenshots.set('sidebar-dragged.png', await activePage.screenshot())

    await shutdown(browser, appProcess)
    page = await launch.call(this, 1200, 800)
    const relaunched = requireInitialized(page, 'The editor page must be initialized')
    const afterRelaunch = await paneWidth(relaunched, 'navigation-sidebar')
    assert.ok(Math.abs(afterRelaunch - dragged) <= 8, `the width is pixels, not a share of the window: ${dragged} -> ${afterRelaunch} at 1200 px`)
    screenshots.set('sidebar-after-relaunch.png', await relaunched.screenshot())
  })

  it('holds the annotation panel at its minimum in a narrow window instead of squeezing it', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.setViewportSize({ width: 1000, height: 700 })
    await activePage.waitForFunction(() => window.innerWidth === 1000, undefined, { timeout: 10_000 })
    await delay(300)
    const panel = await paneWidth(activePage, 'annotation-panel')
    assert.ok(panel >= ANNOTATION_PANEL_MINIMUM - 1, `the panel keeps its minimum: ${panel}px`)
    screenshots.set('narrow-window.png', await activePage.screenshot())
    await activePage.setViewportSize({ width: 1200, height: 800 })
    await activePage.waitForFunction(() => window.innerWidth === 1200, undefined, { timeout: 10_000 })
  })

  it('takes a hidden pane\'s handle with it and hands its width to the editor', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const sidebar = await paneWidth(activePage, 'navigation-sidebar')
    const editorBefore = await paneWidth(activePage, 'editor')
    await activePage.locator(TOGGLE('navigation-sidebar')).click()
    await activePage.locator(PANE('navigation-sidebar')).waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await activePage.locator(HANDLE('navigation-sidebar')).count(), 0, 'the hidden pane leaves no handle behind')
    await waitUntil(async () => Math.abs(await paneWidth(activePage, 'editor') - (editorBefore + sidebar)) <= 3, 'the editor to take the sidebar\'s width')
    screenshots.set('sidebar-hidden.png', await activePage.screenshot())
    await activePage.locator(TOGGLE('navigation-sidebar')).click()
    await activePage.locator(PANE('navigation-sidebar')).waitFor({ state: 'attached', timeout: 10_000 })
    await waitUntil(async () => Math.abs(await paneWidth(activePage, 'navigation-sidebar') - sidebar) <= 8, 'the sidebar to come back at its width')
  })
})

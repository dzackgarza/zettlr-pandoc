/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Window header e2e (PLAN-main-window-chrome-convergence, M4)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the assembled app on a Quarto book workspace and
 *                  asserts the main window renders no toolbar row, that the
 *                  document tab row carries the sidebar and annotation panel
 *                  toggles at its right end and each toggles its pane, that
 *                  a config file still holding the toolbar keys boots and
 *                  loses them, and that the Export menu item opens the
 *                  launcher on the export profiles the assets provider
 *                  offers.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Page } from 'playwright'
import { SUPPORTED_READERS } from '../source/common/pandoc-util/pandoc-maps'
import { parseReaderWriter } from '../source/common/pandoc-util/parse-reader-writer'
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-window-header-e2e-latest')

const TAB_ROW = '.document-tablist-wrapper'
const TOGGLE = (pane: 'navigation-sidebar' | 'annotation-panel'): string => `${TAB_ROW} [data-pane-toggle="${pane}"]`
const LAUNCHER = '[data-command-launcher]'

interface ListedProfile {
  name: string
  isInvalid: boolean
  reader?: string
}

async function readWindowConfig (page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null) {
      throw new Error('The config provider returned no config object')
    }
    return config as Record<string, unknown>
  })
}

function readSection (config: Record<string, unknown>, key: string): Record<string, unknown> {
  const section = config[key]
  if (typeof section !== 'object' || section === null) {
    throw new Error(`The config carries no ${key} section`)
  }
  return section as Record<string, unknown>
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

describe('the window header', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-window-header-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: path.join('foundations', 'forms.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true },
        // The keys a config file written before the toolbar left still holds.
        displayToolbarButtons: { showNewFileButton: false, showPomodoroButton: false },
        display: { hideToolbarInDistractionFree: true }
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
    await editorPage.locator('#navigation-sidebar [data-module="project"]').waitFor({ timeout: 60_000 })
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

  it('renders no toolbar row, and a cold start drops the toolbar keys of an old config', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    assert.equal(await activePage.locator('#toolbar').count(), 0, 'the main window mounts no toolbar')
    const config = await readWindowConfig(activePage)
    assert.equal('displayToolbarButtons' in config, false, 'the toolbar buttons block is gone from the config')
    assert.equal('hideToolbarInDistractionFree' in readSection(config, 'display'), false, 'the distraction-free toolbar flag is gone from the config')
    screenshots.set('window-header.png', await activePage.screenshot())
  })

  it('carries the sidebar and annotation panel toggles at the right end of the document tab row, each toggling its pane', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const toggles = await activePage.locator(`${TAB_ROW} [data-pane-toggle]`).evaluateAll(elements => elements.map(element => element.getAttribute('data-pane-toggle')))
    assert.deepEqual(toggles, [ 'navigation-sidebar', 'annotation-panel' ], 'the tab row carries the two toggles once, in order')
    const tabRight = await activePage.locator(`${TAB_ROW} [role="tab"]`).last().evaluate(element => element.getBoundingClientRect().right)
    const toggleLeft = await activePage.locator(TOGGLE('navigation-sidebar')).evaluate(element => element.getBoundingClientRect().left)
    assert.ok(toggleLeft > tabRight, 'the toggles sit to the right of the last tab')

    await activePage.locator(TOGGLE('navigation-sidebar')).click()
    await activePage.locator('#navigation-sidebar').waitFor({ state: 'detached', timeout: 10_000 })
    await waitUntil(async () => readSection(await readWindowConfig(activePage), 'window').fileManagerVisible === false, 'the sidebar visibility to persist as hidden')
    await activePage.locator(TOGGLE('navigation-sidebar')).click()
    await activePage.locator('#navigation-sidebar').waitFor({ state: 'attached', timeout: 10_000 })
    await waitUntil(async () => readSection(await readWindowConfig(activePage), 'window').fileManagerVisible === true, 'the sidebar visibility to persist as shown')

    await activePage.locator(TOGGLE('annotation-panel')).click()
    await activePage.locator('#annotations-panel').waitFor({ state: 'detached', timeout: 10_000 })
    await waitUntil(async () => readSection(await readWindowConfig(activePage), 'window').sidebarVisible === false, 'the panel visibility to persist as hidden')
    screenshots.set('window-header-panel-hidden.png', await activePage.screenshot())
    await activePage.locator(TOGGLE('annotation-panel')).click()
    await activePage.locator('#annotations-panel').waitFor({ state: 'attached', timeout: 10_000 })
    await waitUntil(async () => readSection(await readWindowConfig(activePage), 'window').sidebarVisible === true, 'the panel visibility to persist as shown')
  })

  it('opens the launcher on the export profiles from the Export menu item, listing what the assets provider offers', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const listed = await activePage.evaluate(async () => {
      const profiles: unknown = await window.ipc.invoke('assets-provider', { command: 'list-export-profiles' })
      if (!Array.isArray(profiles)) {
        throw new Error('The assets provider returned no profile list')
      }
      return profiles as ListedProfile[]
    })
    const expected = listed
      .filter(profile => !profile.isInvalid && profile.reader !== undefined && SUPPORTED_READERS.includes(parseReaderWriter(profile.reader).name))
      .map(profile => profile.name)
      .sort()
    assert.ok(expected.length > 0, 'the fixture app offers at least one usable export profile')

    await clickMenuItem(activePage, 'menu.export')
    await activePage.locator(`${LAUNCHER} [data-launcher-row][data-row-kind="export-profile"]`).first().waitFor({ timeout: 10_000 })
    const rows = await activePage.locator(`${LAUNCHER} [data-launcher-row][data-row-kind="export-profile"]`).evaluateAll(elements => elements.map(element => element.getAttribute('data-export-profile')))
    assert.deepEqual([ ...rows ].sort(), expected, 'the export view lists exactly the usable profiles')
    screenshots.set('window-header-export.png', await activePage.screenshot())
    await activePage.keyboard.press('Escape')
    await activePage.locator(LAUNCHER).waitFor({ state: 'detached', timeout: 10_000 })
  })
})

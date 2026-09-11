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
const PANEL_BAR = '#panel-activity-bar'
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
    await editorPage.locator('#navigation-sidebar [data-section="files"]').waitFor({ timeout: 60_000 })
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

  it('holds tabs and nothing else in the document tab row: no scroller arrows, no pane toggles', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    assert.equal(await activePage.locator(`${TAB_ROW} .scroller`).count(), 0, 'the tab row carries no scroller arrows')
    assert.equal(await activePage.locator('[data-pane-toggle]').count(), 0, 'no pane toggle rides the tab row')
    // What makes the arrows unnecessary: a strip too narrow for its tabs
    // scrolls, so every tab is reachable without a control of its own.
    const overflow = await activePage.locator(`${TAB_ROW} [role="tablist"]`).evaluate(element => getComputedStyle(element).overflowX)
    assert.ok([ 'auto', 'scroll' ].includes(overflow), `the tab strip scrolls: overflow-x is ${overflow}`)
  })

  it('toggles the annotation panel from its own activity bar at the window\'s right edge', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const icon = activePage.locator(`${PANEL_BAR} [data-activity="annotations"]`)
    await icon.waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await icon.getAttribute('aria-pressed'), 'true', 'the icon reads pressed while the panel is open')

    const barLeft = await activePage.locator(PANEL_BAR).evaluate(element => element.getBoundingClientRect().left)
    const panelRight = await activePage.locator('#annotations-panel').evaluate(element => element.getBoundingClientRect().right)
    assert.ok(barLeft >= panelRight - 1, 'the bar sits outside the panel, at the window\'s edge')

    await icon.click()
    await activePage.locator('#annotations-panel').waitFor({ state: 'hidden', timeout: 10_000 })
    await waitUntil(async () => readSection(await readWindowConfig(activePage), 'window').sidebarVisible === false, 'the panel visibility to persist as hidden')
    assert.equal(await icon.getAttribute('aria-pressed'), 'false', 'the icon reads unpressed while the panel is away')
    screenshots.set('window-header-panel-hidden.png', await activePage.screenshot())

    await icon.click()
    await activePage.locator('#annotations-panel').waitFor({ state: 'visible', timeout: 10_000 })
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

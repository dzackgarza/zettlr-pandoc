/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Window status bar e2e (PLAN-main-window-chrome-convergence, M6)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the assembled app on a Quarto book workspace and
 *                  asserts the main window has exactly one status bar, at
 *                  the window bottom, whose editor items follow the focused
 *                  pane across a split while no CodeMirror status panel
 *                  remains; that an export shows up in its task indicator
 *                  and opens the task list from there; and that the
 *                  rendering-mode and diagnostics items act on the editor.
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-window-statusbar-e2e-latest')

const STATUSBAR = '#main-statusbar'
const ITEM = (id: string): string => `${STATUSBAR} [data-statusbar-item="${id}"]`
const LAUNCHER = '[data-command-launcher]'

async function readConfigValue (page: Page, section: string, key: string): Promise<unknown> {
  return await page.evaluate(([ sectionName, keyName ]) => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null || !(sectionName in config)) {
      throw new Error(`The config carries no ${sectionName} section`)
    }
    const section: unknown = (config as Record<string, unknown>)[sectionName]
    if (typeof section !== 'object' || section === null) {
      throw new Error(`The config's ${sectionName} is not an object`)
    }
    return (section as Record<string, unknown>)[keyName]
  }, [ section, key ])
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

/**
 * Splits the one pane side by side and opens a document in the new pane;
 * returns the new leaf's id. The page-side code declares no inner function:
 * the loader's name-keeping helper does not exist in the page.
 */
async function splitAndOpen (page: Page, documentPath: string): Promise<string> {
  return await page.evaluate(async (pathInPage: string) => {
    const windowId = new URLSearchParams(location.search).get('window_id')
    if (windowId === null) {
      throw new Error('The main window carries no window_id')
    }
    const leavesOf: string[][] = []
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        // 'horizontal' is the document manager's side-by-side direction.
        await window.ipc.invoke('documents-provider', {
          command: 'split-leaf',
          payload: { originWindow: windowId, originLeaf: leavesOf[0][0], direction: 'horizontal', insertion: 'after' }
        })
      }
      const tree: unknown = await window.ipc.invoke('documents-provider', { command: 'retrieve-tab-config', payload: { windowId } })
      const leaves: string[] = []
      const stack: unknown[] = [ tree ]
      while (stack.length > 0) {
        const node = stack.pop() as { type: string, id: string, nodes: unknown[] }
        if (node.type === 'leaf') {
          leaves.push(node.id)
        } else {
          stack.push(...node.nodes)
        }
      }
      leavesOf.push(leaves)
      if (pass === 0 && leaves.length !== 1) {
        throw new Error(`Expected a single leaf to split, found ${leaves.length}`)
      }
    }
    const created = leavesOf[1].find(id => !leavesOf[0].includes(id))
    if (created === undefined) {
      throw new Error('The split produced no new leaf')
    }
    await window.ipc.invoke('documents-provider', {
      command: 'open-file',
      payload: { windowId, leafId: created, path: pathInPage, newTab: true }
    })
    return created
  }, documentPath)
}

async function closeLeaf (page: Page, leafId: string): Promise<void> {
  await page.evaluate(async (leaf: string) => {
    const windowId = new URLSearchParams(location.search).get('window_id')
    if (windowId === null) {
      throw new Error('The main window carries no window_id')
    }
    await window.ipc.invoke('documents-provider', { command: 'close-leaf', payload: { windowId, leafId: leaf } })
  }, leafId)
}

describe('the window status bar', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let configDirectory: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-window-statusbar-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: path.join('foundations', 'forms.md'),
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true },
        export: { autoOpenExportedFiles: false, dir: 'temp' }
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

  it('is the one status bar and reads the active document; no CodeMirror status panel remains', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    assert.equal(await activePage.locator(STATUSBAR).count(), 1, 'exactly one status bar')
    assert.equal(await activePage.locator('.cm-statusbar').count(), 0, 'the editor mounts no status panel of its own')
    await waitUntil(async () => /^1 words$/.test((await activePage.locator(ITEM('words')).innerText()).trim()), 'the word count of forms.md')
    assert.equal((await activePage.locator(ITEM('cursor')).innerText()).trim(), 'Ln 1, Col 1')
    const bar = await activePage.locator(STATUSBAR).boundingBox()
    const viewport = activePage.viewportSize()
    assert.ok(bar !== null && viewport !== null && Math.round(bar.y + bar.height) === viewport.height, 'the bar sits at the window bottom')
    assert.ok(bar !== null && viewport !== null && Math.round(bar.width) === viewport.width, 'the bar spans the window')
    screenshots.set('statusbar.png', await activePage.screenshot())
  })

  it('follows the focused pane across a split, with still one bar', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const root = requireInitialized(fixtureRoot, 'fixture')
    const indexPath = path.join(root, 'workspace', 'index.md')
    const leafId = await splitAndOpen(activePage, indexPath)
    const secondPane = activePage.locator('.editor-pane', { has: activePage.locator(`[role="tab"][data-path="${indexPath}"]`) })
    await secondPane.locator('.cm-content').waitFor({ state: 'visible', timeout: 20_000 })
    await secondPane.locator('.cm-content').click()
    await waitUntil(async () => {
      const text = (await activePage.locator(ITEM('words')).innerText()).trim()
      return /^\d+ words$/.test(text) && text !== '1 words'
    }, 'the word count of index.md in the focused pane')
    assert.equal(await activePage.locator(STATUSBAR).count(), 1, 'still exactly one status bar')
    assert.equal(await activePage.locator('.cm-statusbar').count(), 0, 'no pane brings its own status panel')
    // The header row is the top-right pane's: the new pane sits to the right.
    const toggleRows = await activePage.locator('.editor-pane').evaluateAll(panes => panes.map(pane => pane.querySelector('[data-pane-toggle]') !== null))
    assert.deepEqual(toggleRows, [ false, true ], 'only the right pane\'s tab row carries the pane toggles')
    screenshots.set('statusbar-two-panes.png', await activePage.screenshot())

    const firstPane = activePage.locator('.editor-pane', { hasNot: activePage.locator(`[role="tab"][data-path="${indexPath}"]`) }).first()
    await firstPane.locator('.cm-content').click()
    await waitUntil(async () => (await activePage.locator(ITEM('words')).innerText()).trim() === '1 words', 'the word count of forms.md once its pane is focused again')
    await closeLeaf(activePage, leafId)
    await activePage.locator('.editor-pane').first().waitFor({ timeout: 10_000 })
    await waitUntil(async () => (await activePage.locator('.editor-pane').count()) === 1, 'the split to close')
  })

  it('shows a running export in the task indicator and opens the task list from it', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const activeDocument = await activePage.locator('.editor-pane [role="tab"].active').first().getAttribute('data-path')
    assert.ok(activeDocument !== null, 'an active document tab')
    await clickMenuItem(activePage, 'menu.export')
    await activePage.locator(`${LAUNCHER} [data-launcher-row][data-highlighted][data-export-profile]`).waitFor({ timeout: 10_000 })
    await activePage.keyboard.press('Enter')
    await activePage.locator(LAUNCHER).waitFor({ state: 'detached', timeout: 10_000 })
    const indicator = activePage.locator(ITEM('tasks'))
    await indicator.waitFor({ timeout: 30_000 })
    await indicator.click()
    const task = activePage.locator('#lrt-wrapper .title', { hasText: path.basename(activeDocument) })
    await task.waitFor({ timeout: 10_000 })
    screenshots.set('statusbar-export-task.png', await activePage.screenshot())
    await activePage.keyboard.press('Escape')
  })

  it('switches the rendering mode and toggles the diagnostics panel from its items', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await activePage.locator(ITEM('rendering-mode')).click()
    await waitUntil(async () => await readConfigValue(activePage, 'display', 'renderingMode') === 'raw', 'the rendering mode to persist as raw')
    assert.match(await activePage.locator(ITEM('rendering-mode')).innerText(), /Raw/)
    await activePage.locator(ITEM('rendering-mode')).click()
    await waitUntil(async () => await readConfigValue(activePage, 'display', 'renderingMode') === 'preview', 'the rendering mode to persist as preview')

    await activePage.locator(ITEM('diagnostics')).click()
    await activePage.locator('.editor-pane .cm-panel-lint').waitFor({ state: 'visible', timeout: 10_000 })
    await activePage.locator(ITEM('diagnostics')).click()
    await activePage.locator('.editor-pane .cm-panel-lint').waitFor({ state: 'detached', timeout: 10_000 })
  })
})

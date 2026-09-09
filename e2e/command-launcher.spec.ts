/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Command launcher e2e (PLAN-command-launcher, M3)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the assembled app's Ctrl+P command launcher by
 *                  keyboard only and asserts effects, never visibility: the
 *                  sidebar toggle leaves the DOM and flips its config value,
 *                  Insert › Footnote lands a marker at the cursor, Search
 *                  references moves the cursor to the definition's line in
 *                  the defining document, Escape returns focus to where it
 *                  was.
 *
 *                  One hop is driven through the app's own path instead of
 *                  a key: Electron's application-menu accelerators do not
 *                  fire from keys synthesised over CDP (verified: the
 *                  renderer receives every keydown, CodeMirror's own Ctrl+P
 *                  binding fires, the menu's Ctrl+J / Ctrl+Alt+L never do).
 *                  So with focus outside the editor the launcher is opened
 *                  by clicking the View menu item the accelerator belongs
 *                  to, through the same click-menu-item IPC the custom
 *                  menubar uses; the serialised menu proves the item carries
 *                  the accelerator. With editor focus the real Ctrl+P key
 *                  opens it.
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-command-launcher-e2e-latest')

const LAUNCHER = '[data-command-launcher]'
const LAUNCHER_INPUT = `${LAUNCHER} [data-command-launcher-input]`
const HIGHLIGHTED_ROW = `${LAUNCHER} [data-launcher-row][data-highlighted]`
const NAVIGATION_SIDEBAR = '#navigation-sidebar'
const FILTER_INPUT = '#navigation-sidebar .chrome-filter-input'
const LAUNCHER_MENU_ITEM = 'menu.command_launcher'

interface SerializedMenuNode {
  id?: string
  label?: string
  type?: string
  accelerator?: string | null
  submenu?: SerializedMenuNode[]
}

/** The application menu as the menu provider serialises it for this window. */
async function readApplicationMenu (page: Page): Promise<SerializedMenuNode[]> {
  return await page.evaluate(async () => await new Promise<SerializedMenuNode[]>(resolve => {
    window.ipc.on('menu-provider', (_event: unknown, message: { command: string, payload: SerializedMenuNode[] }) => {
      if (message.command === 'application-menu') {
        resolve(message.payload)
      }
    })
    window.ipc.send('menu-provider', { command: 'get-application-menu' })
  }))
}

function findMenuNode (nodes: SerializedMenuNode[], id: string): SerializedMenuNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node
    }
    const nested = node.submenu === undefined ? undefined : findMenuNode(node.submenu, id)
    if (nested !== undefined) {
      return nested
    }
  }
  return undefined
}

/** Opens the launcher the way the accelerator would: by clicking its menu item. */
async function openLauncherFromMenu (page: Page): Promise<void> {
  await page.evaluate(id => {
    window.ipc.send('menu-provider', { command: 'click-menu-item', payload: id })
  }, LAUNCHER_MENU_ITEM)
  await page.locator(LAUNCHER_INPUT).waitFor({ state: 'visible', timeout: 10_000 })
}

async function readConfig (page: Page): Promise<{ fileManagerVisible: boolean }> {
  return await page.evaluate(() => {
    const config: unknown = window.ipc.sendSync('config-provider', { command: 'get-config' })
    if (typeof config !== 'object' || config === null || !('window' in config)) {
      throw new Error('The config provider returned no window section')
    }
    const windowSection: unknown = config.window
    if (
      typeof windowSection !== 'object' || windowSection === null ||
      !('fileManagerVisible' in windowSection) || typeof windowSection.fileManagerVisible !== 'boolean'
    ) {
      throw new Error('The config provider returned no window.fileManagerVisible boolean')
    }
    return { fileManagerVisible: windowSection.fileManagerVisible }
  })
}

async function readEditorDocument (page: Page): Promise<string> {
  return await page.locator('.cm-content').first().evaluate(content => {
    const tile = (content as HTMLElement & { cmTile?: { root?: { view?: { state?: { doc?: { toString(): string } } } } } }).cmTile
    const text = tile?.root?.view?.state?.doc?.toString()
    if (text === undefined) {
      throw new Error('Could not read the active CodeMirror document state')
    }
    return text
  })
}

async function readCursorLine (page: Page): Promise<number> {
  return await page.locator('.cm-content').first().evaluate(content => {
    const tile = (content as HTMLElement & { cmTile?: { root?: { view?: { state?: { doc: { lineAt(pos: number): { number: number } }, selection: { main: { head: number } } } } } } }).cmTile
    const state = tile?.root?.view?.state
    if (state === undefined) {
      throw new Error('Could not read the active CodeMirror selection')
    }
    return state.doc.lineAt(state.selection.main.head).number
  })
}

/** Places the editor cursor at an offset and focuses the editor. */
async function placeCursor (page: Page, offset: number): Promise<void> {
  await page.locator('.cm-content').first().evaluate((content, anchor) => {
    const tile = (content as HTMLElement & { cmTile?: { root?: { view?: { dispatch(spec: { selection: { anchor: number } }): void, focus(): void } } } }).cmTile
    const view = tile?.root?.view
    if (view === undefined) {
      throw new Error('Could not reach the active CodeMirror view')
    }
    view.dispatch({ selection: { anchor } })
    view.focus()
  }, offset)
}

/** Puts the focus outside the editor, in the sidebar's filter input. */
async function focusOutsideEditor (page: Page): Promise<void> {
  await page.locator(FILTER_INPUT).focus({ timeout: 30_000 })
}

async function typeAndWaitForHighlight (page: Page, query: string, label: string): Promise<void> {
  await page.locator(LAUNCHER_INPUT).fill(query)
  await page.locator(HIGHLIGHTED_ROW, { hasText: label }).waitFor({ timeout: 10_000 })
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

describe('the Ctrl+P command launcher', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let page: Page | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createWorkspaceFixture('zettlr-command-launcher-e2e-', {
      workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
      activeDocument: 'index.md',
      config: {
        darkMode: false,
        window: { fileManagerVisible: true, sidebarVisible: true, currentSidebarTab: 'toc' }
      }
    })
    fixtureRoot = fixture.root
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    page = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(page)
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
    await page.locator(FILTER_INPUT).waitFor({ state: 'visible', timeout: 60_000 })
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

  it('carries Ctrl+P on a View menu item that opens the launcher from file-tree focus', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const menu = await readApplicationMenu(activePage)
    const viewMenu = findMenuNode(menu, 'view-menu')
    assert.ok(viewMenu?.submenu !== undefined, 'the View menu must be serialised')
    const item = findMenuNode(viewMenu.submenu, LAUNCHER_MENU_ITEM)
    assert.ok(item !== undefined, 'the View menu must carry the command launcher item')
    assert.equal(item.accelerator, 'Ctrl+P', 'the launcher item must own Ctrl+P')

    await focusOutsideEditor(activePage)
    await openLauncherFromMenu(activePage)
    assert.equal(await activePage.locator(LAUNCHER).count(), 1, 'exactly one launcher opens')
    screenshots.set('launcher-root.png', await activePage.screenshot())

    await activePage.keyboard.press('Escape')
    await activePage.locator(LAUNCHER).waitFor({ state: 'detached', timeout: 10_000 })
    const focusReturned = await activePage.locator(FILTER_INPUT).evaluate(element => element === document.activeElement)
    assert.ok(focusReturned, 'Escape must return the focus to the filter input that had it')
  })

  it('toggles the sidebar off and on through a typed command', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    await focusOutsideEditor(activePage)
    await openLauncherFromMenu(activePage)
    await typeAndWaitForHighlight(activePage, 'sidebar', 'Toggle Sidebar')
    await activePage.keyboard.press('Enter')
    await activePage.locator(NAVIGATION_SIDEBAR).waitFor({ state: 'detached', timeout: 10_000 })
    await waitUntil(async () => !(await readConfig(activePage)).fileManagerVisible, 'window.fileManagerVisible to become false')

    await openLauncherFromMenu(activePage)
    await typeAndWaitForHighlight(activePage, 'sidebar', 'Toggle Sidebar')
    await activePage.keyboard.press('Enter')
    await activePage.locator(NAVIGATION_SIDEBAR).waitFor({ state: 'attached', timeout: 10_000 })
    await waitUntil(async () => (await readConfig(activePage)).fileManagerVisible, 'window.fileManagerVisible to become true')
  })

  it('inserts a footnote at the cursor through the Insert submenu, opened with the real Ctrl+P from the editor', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const before = await readEditorDocument(activePage)
    const cursor = before.indexOf('\n') // the end of the first line, `# Lattice Notes`
    assert.ok(cursor > 0, 'the fixture document must have a first line')
    await placeCursor(activePage, cursor)

    await activePage.keyboard.press('Control+p')
    await activePage.locator(LAUNCHER_INPUT).waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await activePage.locator(LAUNCHER).count(), 1, 'the editor binding opens exactly one launcher')

    await typeAndWaitForHighlight(activePage, 'insert', 'Insert')
    await activePage.keyboard.press('Enter')
    await typeAndWaitForHighlight(activePage, 'foot', 'Footnote')
    screenshots.set('launcher-insert-footnote.png', await activePage.screenshot())
    await activePage.keyboard.press('Enter')
    await activePage.locator(LAUNCHER).waitFor({ state: 'detached', timeout: 10_000 })

    await waitUntil(async () => (await readEditorDocument(activePage)).slice(cursor, cursor + 4) === '[^1]', 'the footnote marker at the cursor')
    const after = await readEditorDocument(activePage)
    assert.equal(after.slice(0, cursor), before.slice(0, cursor), 'the text before the cursor is untouched')

    // Save the edited fixture document so the app can shut down without a
    // native "unsaved changes" prompt the harness cannot answer.
    const indexPath = path.join(requireInitialized(fixtureRoot, 'fixture'), 'workspace', 'index.md')
    await activePage.evaluate(async pathInPage => await window.ipc.invoke('documents:save-file', { path: pathInPage }), indexPath)
    const saved = await readFile(indexPath, 'utf8')
    assert.equal(saved.slice(cursor, cursor + 4), '[^1]', 'the saved document carries the footnote marker')
  })

  it('jumps to a definition in another document through the Search references command', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const formsPath = path.join(requireInitialized(fixtureRoot, 'fixture'), 'workspace', 'foundations', 'forms.md')
    const formsText = await readFile(formsPath, 'utf8')

    await focusOutsideEditor(activePage)
    await openLauncherFromMenu(activePage)
    await typeAndWaitForHighlight(activePage, 'references', 'Search references')
    await activePage.keyboard.press('Enter')
    await activePage.locator(`${LAUNCHER} [data-search-mode="definitions"]`).waitFor({ timeout: 10_000 })
    await activePage.locator(LAUNCHER_INPUT).fill('sec-forms')
    await activePage.locator(`${LAUNCHER} [data-launcher-row][data-highlighted][data-reference-key="sec-forms"]`).waitFor({ timeout: 10_000 })
    screenshots.set('launcher-references.png', await activePage.screenshot())
    await activePage.keyboard.press('Enter')
    await activePage.locator(LAUNCHER).waitFor({ state: 'detached', timeout: 10_000 })

    await waitUntil(async () => (await readEditorDocument(activePage)) === formsText, 'the defining document to become active')
    const definitionLine = formsText.slice(0, formsText.indexOf('{#sec-forms}')).split('\n').length
    await waitUntil(async () => (await readCursorLine(activePage)) === definitionLine, `the cursor on line ${definitionLine}`)
  })
})

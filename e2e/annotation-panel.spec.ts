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
 *                  asserts that the References module lists the active
 *                  document's citations, that the right pane holds the
 *                  annotation review panel and nothing else, and that hiding
 *                  the panel through its View menu item keeps it hidden
 *                  across a restart. Then the annotation thread, which opens
 *                  inside the editor under its target: from the gutter chip
 *                  and from the panel row, and the owner's reply, resolve
 *                  and delete from the thread, each checked against the
 *                  provider's collaboration session.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Locator, type Page } from 'playwright'
import type { TextAnnotation } from '../source/types/common/annotation-domain'
import type { DocumentCollaborationSession } from '../source/types/common/document-collaboration'
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
/** The editor pane: annotation threads open inside it, under their target. */
const EDITOR = '.main-editor-wrapper .cm-editor'

/** Long enough that a panel row which cut it short would show it. */
const LATTICE_INSTRUCTION = 'Say which lattices these are, name the bilinear form each one carries, and state whether the notes mean the even unimodular ones throughout.'
const REPLY = 'Only the even unimodular ones, please.'

/** The one open thread for an annotation, inside the editor. */
function inlineThread (page: Page, annotationId: string): Locator {
  return page.locator(`${EDITOR} .cm-collaborationControl-annotation-thread [data-annotation-detail][data-annotation-id="${annotationId}"]`)
}

let indexPath: string | undefined

async function collaborationSessionOf (page: Page): Promise<DocumentCollaborationSession> {
  const session = await page.evaluate(async pathInPage => await window.ipc.invoke('documents-provider', {
    command: 'get-collaboration-session', payload: { path: pathInPage }
  }), requireInitialized(indexPath, 'index.md path'))
  assert.ok(session !== undefined, 'the provider holds a collaboration session for index.md')
  return session
}

async function annotationOf (page: Page, annotationId: string): Promise<TextAnnotation> {
  const found = (await collaborationSessionOf(page)).annotations.items.find(item => item.annotationId === annotationId)
  assert.ok(found !== undefined, `the provider holds no annotation ${annotationId}`)
  return found
}

/** Creates an annotation through the owner's IPC channel and returns its id. */
async function createAnnotation (page: Page, from: number, to: number, instruction: string): Promise<string> {
  const generation = (await collaborationSessionOf(page)).annotations.generation
  const created: unknown = await page.evaluate(async input => await window.ipc.invoke('documents:create-annotation', input), {
    path: requireInitialized(indexPath, 'index.md path'), from, to, instruction, expectedAnnotationGeneration: generation
  })
  assert.ok(typeof created === 'object' && created !== null && 'annotationId' in created && typeof created.annotationId === 'string',
    `the annotation was created: ${JSON.stringify(created)}`)
  return created.annotationId
}

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
  /** The annotation on "Lattice" the thread tests share. */
  let lattice: string | undefined
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
    indexPath = path.join(fixture.root, 'workspace', 'index.md')
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

  it('opens and closes the annotation\'s thread in the editor from its gutter chip', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    // index.md reads `# Lattice Notes`: the annotation targets "Lattice".
    // Opening it from the tree makes it the active, loaded document.
    await activePage.locator(`${SIDEBAR} [data-section="files"] .tree-item.file[data-path$="/index.md"]`).click()
    await waitUntil(async () => /Lattice/.test(await activePage.locator('.cm-content').innerText()), 'index.md to be the active document')

    lattice = await createAnnotation(activePage, 2, 9, LATTICE_INSTRUCTION)

    const chip = activePage.locator('.cm-textAnnotation-gutterMarker')
    await chip.waitFor({ state: 'visible', timeout: 10_000 })
    await chip.click()
    const thread = inlineThread(activePage, lattice)
    await thread.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await thread.innerText(), /Say which lattices these are/, 'the chip\'s annotation is the one opened')
    assert.equal(await activePage.locator(`${EDITOR} [data-annotation-detail]`).count(), 1, 'one thread is open')
    await waitUntil(async () => (await activePage.locator('.cm-textAnnotation-gutterMarker-active').count()) === 1, 'the chip to show as active')
    screenshots.set('thread-from-chip.png', await activePage.screenshot())

    await chip.click()
    await thread.waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await activePage.locator('.cm-textAnnotation-gutterMarker-active').count(), 0, 'closing the thread deactivates the chip')
  })

  it('opens the thread from the annotation\'s row in the workspace panel', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const annotationId = requireInitialized(lattice, 'The previous test must have created the annotation')
    const row = activePage.locator(`${PANEL} .annotation-workspace-row[data-annotation-id="${annotationId}"]`)
    await row.waitFor({ state: 'visible', timeout: 10_000 })
    // The row leads with the owner's whole reason: nothing about it is cut
    // off, however narrow the panel is.
    const summary = row.locator('.annotation-workspace-summary')
    assert.equal(await summary.innerText(), LATTICE_INSTRUCTION)
    assert.ok(
      await summary.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight + 1),
      'the reason is shown whole, not clipped'
    )

    await row.click()
    await inlineThread(activePage, annotationId).waitFor({ state: 'visible', timeout: 10_000 })
  })

  it('replies in the thread, and the reply lands on the annotation', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const annotationId = requireInitialized(lattice, 'The first annotation test must have created the annotation')
    const thread = inlineThread(activePage, annotationId)
    await thread.locator('.annotation-composer-input').fill(REPLY)
    await thread.locator('.annotation-composer-input').press('Control+Enter')

    await waitUntil(async () => (await thread.locator('.annotation-message-text').allInnerTexts()).includes(REPLY), 'the reply to appear in the thread')
    const messages = (await annotationOf(activePage, annotationId)).messages
    assert.deepEqual(
      messages.map(message => [message.author, message.text]),
      [['owner', LATTICE_INSTRUCTION], ['owner', REPLY]],
      'the provider holds the reply after the instruction, as the owner\'s'
    )
    assert.equal(await thread.locator('.annotation-composer-input').inputValue(), '', 'a sent reply clears the composer')
    screenshots.set('thread-after-reply.png', await activePage.screenshot())
  })

  it('resolves an annotation from its thread', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    // "See" opens line 3, so this annotation has a chip of its own.
    const see = await createAnnotation(activePage, 17, 20, 'Name the definition this refers to.')
    await activePage.locator('.cm-textAnnotation-gutterMarker').nth(1).click()
    const thread = inlineThread(activePage, see)
    await thread.waitFor({ state: 'visible', timeout: 10_000 })

    await thread.locator('[data-annotation-action="resolve"]').click()
    await waitUntil(async () => (await annotationOf(activePage, see)).state === 'resolved', 'the provider to hold the annotation as resolved')
    await thread.waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await activePage.locator('.cm-textAnnotation-gutterMarker').count(), 1, 'a resolved annotation leaves the gutter')
    assert.equal(await activePage.locator(`${PANEL} .annotation-workspace-row[data-annotation-id="${see}"]`).count(), 0, 'and the panel')
  })

  it('deletes the annotation from its thread, once the owner confirms', async function () {
    const activePage = requireInitialized(page, 'The editor page must be initialized')
    const annotationId = requireInitialized(lattice, 'The first annotation test must have created the annotation')
    await activePage.locator('.cm-textAnnotation-gutterMarker').first().click()
    const thread = inlineThread(activePage, annotationId)
    await thread.waitFor({ state: 'visible', timeout: 10_000 })

    // Deleting takes the thread with it and nothing brings it back, so the
    // first click only asks; backing out leaves the annotation alone.
    await thread.locator('[data-annotation-action="delete"]').click()
    const confirm = activePage.locator('[data-annotation-confirm="delete"]')
    await confirm.waitFor({ state: 'visible', timeout: 10_000 })
    screenshots.set('delete-confirmation.png', await activePage.screenshot())
    await activePage.keyboard.press('Escape')
    await confirm.waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await activePage.locator('.cm-textAnnotation-gutterMarker').count(), 1, 'backing out of the confirmation keeps the annotation')

    await thread.locator('[data-annotation-action="delete"]').click()
    await confirm.waitFor({ state: 'visible', timeout: 10_000 })
    await confirm.click()
    await waitUntil(async () => (await activePage.locator('.cm-textAnnotation-gutterMarker').count()) === 0, 'the chip to leave the editor')
    await waitUntil(async () => (await activePage.locator(`${PANEL} .annotation-workspace-row[data-annotation-id="${annotationId}"]`).count()) === 0, 'the row to leave the panel')
    assert.equal(await activePage.locator(`${EDITOR} [data-annotation-detail]`).count(), 0, 'the thread closes with its annotation')
    const session = await collaborationSessionOf(activePage)
    assert.equal(session.annotations.items.some(item => item.annotationId === annotationId), false, 'the provider no longer holds it')
    screenshots.set('after-delete.png', await activePage.screenshot())
  })
})

/**
 * Assembled-app proof of Fix All: the Format menu's three commands ask
 * Flowmark for the machine-applicable fixes of a scope, show how many fixes
 * change how many documents, and apply exactly those fixes on confirmation.
 * A suggestion that needs the author's choice is never applied.
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type EditorView } from '@codemirror/view'
import { type Browser, type Page } from 'playwright'
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  shutdown
} from './support/electron-app'

const INDEX = 'Let $sin x = 0$.\n'
const OTHER = 'Then $cos y + sin z = 1$.\n'
const CLEAN = '# Clean\n\nNothing to fix.\n'

const DIALOG = '[data-fix-all-dialog]'
const SUMMARY = `${DIALOG} [data-fix-all-summary]`

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } }

async function editorText (page: Page): Promise<string> {
  return await page.locator('.cm-content').filter({ visible: true }).evaluate(content => {
    const view = (content as EditorContentElement).cmTile?.root.view
    if (view === undefined) {
      throw new Error('The visible .cm-content has no CodeMirror view')
    }
    return view.state.doc.toString()
  })
}

async function clickMenuItem (page: Page, id: string): Promise<void> {
  await page.evaluate(itemId => {
    window.ipc.send('menu-provider', { command: 'click-menu-item', payload: itemId })
  }, id)
}

/** The summary once the plan has arrived. */
async function plannedSummary (page: Page): Promise<string> {
  const summary = page.locator(SUMMARY)
  await summary.waitFor({ state: 'visible', timeout: 60_000 })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const text = (await summary.textContent()) ?? ''
    if (!text.startsWith('Finding fixes')) {
      return text
    }
    await delay(150)
  }
  throw new Error('Fix All never received its plan')
}

async function waitForFile (filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await readFile(filePath, 'utf8') === expected) {
      return
    }
    await delay(150)
  }
  assert.equal(await readFile(filePath, 'utf8'), expected)
}

describe('assembled app: Fix All applies the machine-applicable fixes', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let fixtureRoot: string | undefined
  let workspace = ''
  let indexPath = ''
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createFixture('zettlr-fix-all-e2e-', {
      documentName: 'index.md',
      documentContents: INDEX
    })
    fixtureRoot = fixture.root
    indexPath = fixture.documentPath
    workspace = path.dirname(indexPath)
    await writeFile(path.join(workspace, 'other.md'), OTHER, 'utf8')
    await writeFile(path.join(workspace, 'clean.md'), CLEAN, 'utf8')

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    page = await findEditorPage(app.browser, this.timeout())
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
  })

  after(async function () {
    if (page !== undefined) {
      screenshots.set('fix-all.png', await page.screenshot())
    }
    await shutdown(browser, appProcess)
    await preserveArtifacts(
      path.join(tmpdir(), 'zettlr-fix-all-e2e-latest'),
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots
    )
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    assertCleanExit(getOutput())
  })

  it('fixes the focused document after the user confirms the count', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    await clickMenuItem(page, 'menu.fix_all_document')
    assert.equal(await plannedSummary(page), 'Apply 1 fix to 1 of 1 document? Every fix keeps the meaning of the text.')
    assert.match((await page.locator(`${DIALOG} [data-fix-all-rules]`).textContent()) ?? '', /math\/bare-operator\s*1/)
    screenshots.set('fix-all-document.png', await page.screenshot())

    await page.locator(`${DIALOG} [data-fix-all-confirm]`).click()
    await page.locator(DIALOG).waitFor({ state: 'detached', timeout: 10_000 })
    await waitForFile(indexPath, 'Let $\\sin x = 0$.\n')
    assert.equal(await editorText(page), 'Let $\\sin x = 0$.\n')
    assert.equal(await readFile(path.join(workspace, 'other.md'), 'utf8'), OTHER, 'the document scope leaves other documents alone')
  })

  it('summarises the workspace per rule and per document, then fixes the closed files', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    await clickMenuItem(page, 'menu.fix_all_workspace')
    assert.equal(await plannedSummary(page), 'Apply 2 fixes to 1 of 3 documents? Every fix keeps the meaning of the text.')
    assert.match((await page.locator(`${DIALOG} [data-fix-all-documents]`).textContent()) ?? '', /other\.md\s*2/)
    screenshots.set('fix-all-workspace.png', await page.screenshot())

    await page.locator(`${DIALOG} [data-fix-all-confirm]`).click()
    await waitForFile(path.join(workspace, 'other.md'), 'Then $\\cos y + \\sin z = 1$.\n')
    assert.equal(await readFile(path.join(workspace, 'clean.md'), 'utf8'), CLEAN)
  })

  it('reports that nothing is left to fix', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    await clickMenuItem(page, 'menu.fix_all_open')
    assert.equal(await plannedSummary(page), 'No auto-fixable issues in 1 document.')
    assert.equal(await page.locator(`${DIALOG} [data-fix-all-confirm]`).count(), 0)
    await page.keyboard.press('Escape')
  })
})

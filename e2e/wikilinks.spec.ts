/**
 * Assembled-app proof that wikilinks keep naming their documents.
 *
 * Moving a file and renaming a directory through the file manager's commands
 * rewrite every link whose document the change altered: a relative link that
 * no longer reaches its file, and a name the change gave to another document.
 * A link that names one document renders as a chip; a missing link stays raw.
 * A Ctrl-click on `[[name#heading]]` opens the named document with the cursor
 * on that heading.
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
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

const INDEX = `# Index

Chain: [[./programs/chain.md]]

Lemma: [[x/lemma]]

Step: [[chain#Second step|the step]]

Missing: [[nowhere]]
`

const CHAIN = `# First step

See [[../notes/basis.md]].

# Second step

Done.
`

const WORKSPACE: Record<string, string> = {
  'programs/chain.md': CHAIN,
  'notes/basis.md': '# Basis\n',
  'deep/x/lemma.md': '# Lemma A\n',
  'other/lemma.md': '# Lemma B\n',
  'archive/2026/placeholder.md': '# Placeholder\n'
}

type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } }

/** The text and cursor line of every mounted editor. */
async function editorStates (page: Page): Promise<Array<{ text: string, cursorLine: number }>> {
  return await page.locator('.cm-content').evaluateAll(contents => contents.map(content => {
    const view = (content as EditorContentElement).cmTile?.root.view
    if (view === undefined) {
      throw new Error('A mounted .cm-content has no CodeMirror view')
    }
    const text = view.state.doc.toString()
    return { text, cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number }
  }))
}

describe('assembled app: wikilinks follow their documents', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let fixtureRoot: string | undefined
  let workspace = ''
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createFixture('zettlr-wikilinks-e2e-', {
      documentName: 'index.md',
      documentContents: INDEX
    })
    fixtureRoot = fixture.root
    workspace = path.dirname(fixture.documentPath)
    for (const [ relativePath, contents ] of Object.entries(WORKSPACE)) {
      await mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true })
      await writeFile(path.join(workspace, relativePath), contents, 'utf8')
    }

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    page = await findEditorPage(app.browser, this.timeout())
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: this.timeout() })
  })

  after(async function () {
    if (page !== undefined) {
      screenshots.set('wikilinks.png', await page.screenshot())
    }
    await shutdown(browser, appProcess)
    await preserveArtifacts(
      path.join(tmpdir(), 'zettlr-wikilinks-e2e-latest'),
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

  it('rewrites the relative links into and out of a moved file', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    const moved = await page.evaluate(async payload => await window.ipc.invoke('application', {
      command: 'request-move',
      payload
    }), { from: path.join(workspace, 'programs', 'chain.md'), to: path.join(workspace, 'archive', '2026') })
    assert.equal(moved, true)

    assert.equal(
      await readFile(path.join(workspace, 'index.md'), 'utf8'),
      INDEX.replace('[[./programs/chain.md]]', '[[chain]]')
    )
    assert.equal(
      await readFile(path.join(workspace, 'archive', '2026', 'chain.md'), 'utf8'),
      CHAIN.replace('[[../notes/basis.md]]', '[[basis]]')
    )
  })

  it('rewrites a name that a directory rename gives to another document', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    const renamed = await page.evaluate(async payload => await window.ipc.invoke('application', {
      command: 'dir-rename',
      payload
    }), { path: path.join(workspace, 'other'), name: 'x' })
    assert.equal(renamed, true)

    assert.equal(
      await readFile(path.join(workspace, 'index.md'), 'utf8'),
      INDEX.replace('[[./programs/chain.md]]', '[[chain]]').replace('[[x/lemma]]', '[[deep/x/lemma]]')
    )
    assert.equal(await readFile(path.join(workspace, 'x', 'lemma.md'), 'utf8'), '# Lemma B\n')
  })

  it('renders each link that names one document as a chip, and a missing link raw', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    const indexText = await readFile(path.join(workspace, 'index.md'), 'utf8')
    await page.waitForFunction(expected => [...document.querySelectorAll('.cm-content')].some(content =>
      (content as EditorContentElement).cmTile?.root.view.state.doc.toString() === expected
    ), indexText, { timeout: this.timeout() })

    // The cursor on the heading leaves every link line rendered
    await page.locator('.cm-line', { hasText: 'Index' }).first().click()
    // The chips of the links that the rename rewrote wait for the main
    // process to resolve the new targets; the others are already drawn.
    const chips = page.locator('.wikilink-chip')
    const expectedChips = [ 'chain', 'deep/x/lemma', 'the step' ]
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !isDeepStrictEqual(await chips.allTextContents(), expectedChips)) {
      await delay(100)
    }
    assert.deepEqual(await chips.allTextContents(), expectedChips)
    assert.equal(
      await chips.filter({ hasText: 'the step' }).getAttribute('title'),
      path.join(workspace, 'archive', '2026', 'chain.md')
    )
    assert.equal(await page.locator('.cm-line', { hasText: 'Missing:' }).textContent(), 'Missing: [[nowhere]]')
  })

  it('opens [[name#heading]] with the cursor on that heading', async function () {
    assert.ok(page !== undefined, 'The editor window must be open')
    await page.locator('.wikilink-chip', { hasText: 'the step' }).click({ modifiers: ['Control'] })

    const chainText = await readFile(path.join(workspace, 'archive', '2026', 'chain.md'), 'utf8')
    const headingLine = chainText.split('\n').indexOf('# Second step') + 1
    const deadline = Date.now() + 30_000
    let states = await editorStates(page)
    while (!states.some(state => state.text === chainText && state.cursorLine === headingLine)) {
      assert.ok(Date.now() < deadline, `No editor showed chain.md with the cursor on line ${headingLine}: ${JSON.stringify(states)}`)
      await delay(100)
      states = await editorStates(page)
    }
  })
})

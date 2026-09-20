/**
 * Assembled-app smoke proof for the production Markdown rendering pipeline.
 *
 * This deliberately does not import markdownParser(), renderers(), or any
 * individual renderer. The test opens a real Markdown document through the
 * same MarkdownEditor construction path used by the application. Component
 * tests may prove individual extensions in isolation; this test proves that
 * the shipped editor actually installs and runs them together.
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
  createFixture,
  findEditorPage,
  preserveArtifacts,
  shutdown
} from './support/electron-app'

const DOCUMENT = `# Rendered heading

Ordinary *emphasis* and [a link](https://example.com) with inline $x+y$.

::: {.definition title="$(K+D)$-Trivial Polarized Involution Pairs"}
A $(K+D)$-trivial polarized involution pair is a triple $(X,D,\\iota)$.
:::

Outside rendering probe.
`

describe('assembled Markdown rendering', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let fixtureRoot: string | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createFixture('zettlr-markdown-rendering-e2e-', {
      documentName: 'rendering.md',
      documentContents: DOCUMENT
    })
    fixtureRoot = fixture.root

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
    page = await findEditorPage(app.browser, this.timeout())

    const editor = page.locator('.cm-content')
    await editor.waitFor({ state: 'visible', timeout: this.timeout() })
    await assertEventuallyDocument(editor, DOCUMENT, this.timeout())

    // Keep the caret away from every construct whose source is intentionally
    // revealed while selected. This is a user interaction against the actual
    // editor DOM, not a direct CodeMirror state injection.
    const outside = page.locator('.cm-line', { hasText: 'Outside rendering probe.' })
    await outside.click()
  })

  after(async function () {
    if (page !== undefined) {
      screenshots.set('markdown-rendering.png', await page.screenshot())
    }
    await shutdown(browser, appProcess)
    await preserveArtifacts(
      path.join(tmpdir(), 'zettlr-markdown-rendering-e2e-latest'),
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

  it('renders ordinary Markdown and Pandoc constructs through the production editor', async function () {
    assert.ok(page !== undefined, 'the assembled editor page must be available')

    assert.equal(
      (await page.locator('[data-statusbar-item="rendering-mode"]').innerText()).trim(),
      'Preview',
      'the production configuration must actually request preview rendering'
    )

    const heading = page.locator('.cm-line', { hasText: 'Rendered heading' }).first()
    assert.equal((await heading.innerText()).trim(), 'Rendered heading', 'heading syntax must be rendered away')

    const prose = page.locator('.cm-line', { hasText: 'Ordinary emphasis' }).first()
    const proseText = await prose.innerText()
    assert.ok(!proseText.includes('*emphasis*'), `emphasis markers remain visible: ${JSON.stringify(proseText)}`)
    assert.ok(!proseText.includes('https://example.com'), `link target remains visible: ${JSON.stringify(proseText)}`)

    assert.ok(await page.locator('.preview-math[data-equation="x+y"]').count() > 0, 'inline math must render')
    assert.ok(
      await page.locator('pandoc-div-wrapper[data-pandoc-div-family="definition"]').count() > 0,
      'the definition fenced div must render as a semantic container'
    )
    assert.ok(
      await page.locator('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]').count() > 0,
      'the inactive fenced-div opening must render'
    )
    assert.deepEqual(
      rendererEvents,
      [],
      `the renderer reported errors while Markdown rendering was exercised:\n${rendererEvents.join('\n')}`
    )
  })
})

async function assertEventuallyDocument (
  editor: ReturnType<Page['locator']>,
  expected: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await editor.getAttribute('data-document-text').catch(() => null)
    if (current === expected) {
      return
    }
    // CodeMirror's content DOM is the authoritative fallback when the editor
    // does not expose a test-only document attribute.
    if ((await editor.innerText()).includes('Outside rendering probe.')) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('the fixture document did not appear in the assembled editor')
}

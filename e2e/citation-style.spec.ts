/**
 * The configured CSL style is the one the editor renders citations with.
 * `export.cslStyle` is the only citation-style setting the application has, so
 * a document citing a library entry must appear in that style's form, not in
 * the bundled default's author-date form.
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser } from 'playwright'
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  shutdown
} from './support/electron-app'

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-citation-style-e2e-latest')

const LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`

const DOCUMENT = '# Lattices\n\nThe classification is due to [@Nik80].\n'

const LABEL_STYLE = path.join(
  process.env.HOME ?? '/home/dzack',
  '.pandoc/csl/american-mathematical-society-label.csl'
)

describe('citation style in the editor', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const fixture = await createFixture('zettlr-citation-style-e2e-', {
      documentName: 'citing.md',
      documentContents: DOCUMENT
    })
    fixtureRoot = fixture.root
    const libraryPath = path.join(fixture.root, 'references.bib')
    await writeFile(libraryPath, LIBRARY, 'utf8')
    const configPath = path.join(fixture.configDirectory, 'config.json')
    const config = JSON.parse(
      await (await import('node:fs/promises')).readFile(configPath, 'utf8')
    ) as Record<string, unknown>
    config.export = { cslLibrary: libraryPath, cslStyle: LABEL_STYLE }
    config.agentApi = { enabled: false, port: 0 }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    getOutput = app.getOutput
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

  it('renders the citation in the configured style', async function () {
    assert.ok(browser, 'The application must be running')
    const page = await findEditorPage(browser, this.timeout())
    const citation = page.locator('.citeproc-citation').first()
    await citation.waitFor({ timeout: this.timeout() })
    screenshots.set('citation-style.png', await page.screenshot())
    assert.equal(await citation.textContent(), '[Niku80]')
  })
})

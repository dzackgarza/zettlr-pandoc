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

@article{DM20,
  author = {Dolgachev, Igor and Markushevich, Dimitri},
  title = {Lagrangian tens of planes},
  year = {2020},
  journaltitle = {arXiv},
}
`

const DOCUMENT = '# Lattices\n\nThe classification is due to [@Nik80] and [@DM20], jointly [@Nik80; @DM20].\n'

/**
 * A label style, written into the fixture so the run owns it. It keeps the
 * `<sort>` a real label style carries: sorting reads each cited item from the
 * engine's registry, which is what a multi-key cluster needs registered.
 */
const LABEL_STYLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info>
    <title>Label fixture</title>
    <id>https://zettlr.test/styles/label-fixture</id>
    <updated>2026-01-01T00:00:00+00:00</updated>
  </info>
  <citation>
    <sort><key variable="citation-number"/></sort>
    <layout prefix="[" suffix="]" delimiter=", ">
      <text variable="citation-label"/>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <text variable="citation-label" prefix="[" suffix="] "/>
      <text variable="title"/>
    </layout>
  </bibliography>
</style>
`

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
    const stylePath = path.join(fixture.root, 'label.csl')
    await writeFile(stylePath, LABEL_STYLE_XML, 'utf8')
    const configPath = path.join(fixture.configDirectory, 'config.json')
    const config = JSON.parse(
      await (await import('node:fs/promises')).readFile(configPath, 'utf8')
    ) as Record<string, unknown>
    config.export = { cslLibrary: libraryPath, cslStyle: stylePath }
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

  it('labels citations with their citekeys under a label style', async function () {
    assert.ok(browser, 'The application must be running')
    const page = await findEditorPage(browser, this.timeout())
    const citations = page.locator('.citeproc-citation')
    await citations.first().waitFor({ timeout: this.timeout() })
    screenshots.set('citation-style.png', await page.screenshot())
    // The citekeys are the labels the author writes and reads, so a label
    // style must print them, not a label citeproc invents from the names.
    assert.deepEqual(
      await citations.allTextContents(),
      [ '[Nik80]', '[DM20]', '[Nik80, DM20]' ]
    )
  })
})

/**
 * Reproduces the reported inline-math background: in the running application,
 * some inline math inside a Pandoc div is painted with an opaque background
 * that other inline math does not receive.
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
  createFixture,
  findEditorPage,
  preserveArtifacts,
  shutdown
} from './support/electron-app'

const ARTIFACT_DIRECTORY = path.join(tmpdir(), 'zettlr-inline-math-background-e2e-latest')

const DOCUMENT =
  '# Basics of Coble surfaces\n\n' +
  '::: {.remark title="On defining Cobles"}\n\n' +
  'A Coble surface is a rational surface with $\\lvert -K_S \\rvert = \\emptyset$ ' +
  'but $\\lvert -2K_S \\rvert \\neq \\emptyset$.\n' +
  'The curve decomposes as $C = C_1 + C_2$ with $C_i^2 = -4$.\n' +
  ':::\n\n' +
  'Outside the div, $\\lvert -K_S \\rvert = \\emptyset$ and $C = C_1 + C_2$.\n'

interface PaintedMath {
  math: string
  painters: Array<{ cls: string, bg: string, width: number }>
  stack: Array<{ tag: string, cls: string, bg: string }>
}

/**
 * Reports, for every rendered inline-math widget, the elements that paint an
 * opaque background over it. Ancestors that span the whole editor (scroller,
 * div wrapper) are excluded: they paint the page, not the math.
 */
async function paintedMath (page: Page): Promise<PaintedMath[]> {
  // The page script is passed as source: the test runner's transform injects
  // helper identifiers that do not exist in the renderer context.
  return await page.evaluate(`(() => {
    const results = []
    for (const widget of document.querySelectorAll('.preview-math')) {
      const box = widget.getBoundingClientRect()
      if (box.width === 0) continue
      const painters = []
      // Document content and the background layers only: the surrounding
      // panels (status bar) legitimately paint over content that scrolls
      // beneath them.
      const candidates = [
        ...document.querySelectorAll('.cm-content *'),
        ...document.querySelectorAll('.cm-layer > *')
      ]
      for (const candidate of candidates) {
        const bg = getComputedStyle(candidate).backgroundColor
        if (bg === 'transparent' || bg.indexOf('rgba(0, 0, 0, 0') === 0) continue
        if (candidate.contains(widget)) continue
        // Fragments, not the bounding box: an inline element that wraps paints
        // only its own line boxes, while its bounding box is their union and
        // covers text it never touches.
        const fragments = Array.from(candidate.getClientRects())
        const other = fragments.find(f => f.width > 0 && f.height > 0 &&
          f.left < box.right && box.left < f.right &&
          f.top < box.bottom && box.top < f.bottom)
        if (other !== undefined) {
          painters.push({
            cls: String(candidate.className),
            bg,
            width: Math.round(other.width),
            rect: [ Math.round(other.left), Math.round(other.top), Math.round(other.width), Math.round(other.height) ],
            mathRect: [ Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height) ],
            text: (candidate.textContent || '').slice(0, 40)
          })
        }
      }
      // A painter can also be an ancestor of the widget — a mark decoration
      // that spans the math, or the widget's own wrapper — so walk the chain
      // up to the content element as well.
      let node = widget.parentElement
      while (node !== null && !node.classList.contains('cm-content')) {
        const bg = getComputedStyle(node).backgroundColor
        if (bg !== 'transparent' && bg.indexOf('rgba(0, 0, 0, 0') !== 0) {
          painters.push({
            cls: String(node.className) + ' [ancestor]',
            bg,
            width: Math.round(node.getBoundingClientRect().width),
            rect: [ 0, 0, 0, 0 ],
            mathRect: [ Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height) ],
            text: (node.textContent || '').slice(0, 40)
          })
        }
        node = node.parentElement
      }
      const probeX = Math.round(box.left + 2)
      const probeY = Math.round(box.top + box.height / 2)
      const stack = document.elementsFromPoint(probeX, probeY).map(el => ({
        tag: el.tagName,
        cls: String(el.className),
        bg: getComputedStyle(el).backgroundColor
      }))
      results.push({ math: (widget.textContent || '').slice(0, 30), painters, stack })
    }
    return results
  })()`) as PaintedMath[]
}

/**
 * The reported state used the reader's own settings (font size, line numbers,
 * citation library). REPRO_CONFIG points at that config.json; its workspace
 * keys are dropped so the fixture keeps its own workspace.
 */
async function reproConfig (): Promise<Record<string, unknown>|undefined> {
  const configPath = process.env.REPRO_CONFIG
  const library = process.env.REPRO_LIBRARY
  if (configPath === undefined) {
    return library === undefined ? undefined : { export: { cslLibrary: library } }
  }
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  delete parsed.app
  delete parsed.openDirectory
  // The reader's own Zettlr may be running and holding its configured Agent
  // API port; the fixture must not compete for it.
  parsed.agentApi = { enabled: false, port: 0 }
  return parsed
}

describe('inline math in the live editor', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let getOutput: () => string = () => ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    const override = process.env.REPRO_DOC
    const fixture = await createFixture('zettlr-inline-math-background-e2e-', {
      documentName: 'inline-math.md',
      documentContents: override === undefined ? DOCUMENT : await readFile(override, 'utf8'),
      config: await reproConfig()
    })
    fixtureRoot = fixture.root
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

  it('paints no background behind rendered inline math', async function () {
    assert.ok(browser, 'The application must be running')
    const page = await findEditorPage(browser, this.timeout())
    await page.locator('.preview-math').first().waitFor({ timeout: this.timeout() })
    // The reported state has the cursor inside the div, which switches the div
    // from its rendered widget back to its source lines.
    const activation = await page.evaluate(`(() => {
      const content = document.querySelector('.cm-content')
      const view = content.cmTile.root.view
      const text = view.state.doc.toString()
      const marker = text.indexOf('rational surface with')
      if (marker < 0) throw new Error('fixture line not found')
      view.focus()
      view.dispatch({ selection: { anchor: marker + 4 } })
      return { anchor: view.state.selection.main.head }
    })()`)
    await page.waitForTimeout(600)
    console.log('cursor placed at', JSON.stringify(activation))
    if (process.env.REPRO_EDIT !== undefined) {
      // The reported state arises while typing a citekey that the library does
      // not contain, so break a resolvable key in place rather than loading a
      // document that was already broken.
      const edit = await page.evaluate(`(() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const at = view.state.doc.toString().indexOf('@CD85')
        if (at < 0) throw new Error('the fixture has no @CD85 to break')
        view.dispatch({ changes: { from: at + 4, to: at + 5, insert: '9' } })
        return view.state.doc.sliceString(at, at + 6)
      })()`)
      await page.waitForTimeout(800)
      console.log('edited citekey to', JSON.stringify(edit))
    }
    console.log('div states:', await page.evaluate(`Array.from(document.querySelectorAll('[data-pandoc-div-state]')).map(el => el.getAttribute('data-pandoc-div-state')).join(',')`))
    // The reported layout has the file manager open, so the editor column is
    // narrower than this harness's default and the paragraph wraps elsewhere.
    // Sweep the widths a reader could have, since the defect may depend on
    // where a rendered citation breaks across lines.
    const painted: PaintedMath[] = []
    for (const width of [ 1876, 1600, 1400, 1200, 1000 ]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.waitForTimeout(400)
      const report = await paintedMath(page)
      const hits = report.filter(entry => entry.painters.length > 0)
      console.log(`width ${width}: ${report.length} math, ${hits.length} painted`)
      for (const hit of hits) {
        console.log('   ', hit.math, JSON.stringify(hit.painters))
      }
      screenshots.set(`inline-math-${width}.png`, await page.screenshot())
      painted.push(...hits)
    }
    assert.deepEqual(painted, [], 'no inline math may receive its own background')
  })
})

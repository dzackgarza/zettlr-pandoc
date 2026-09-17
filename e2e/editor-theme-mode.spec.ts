/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app editor theme enum regression
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Proves that a cold-mounted editor starts in the persisted
 *                  light/dark enum state and that live changes preserve the
 *                  explicit light/dark semantics. `match` is the only value
 *                  that follows the application dark-mode setting.
 *
 * END HEADER
 */

import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { type Browser, type Page } from 'playwright'
import {
  attach,
  createFixture,
  findEditorPage,
  shutdown
} from './support/electron-app'

interface ThemeSample {
  appDarkMode: boolean
  editorMode: 'match'|'light'|'dark'
  bodyDark: boolean
  background: string
  foreground: string
}

interface RGB {
  r: number
  g: number
  b: number
}

/**
 * Decode the one physical pixel produced by a 1×1 Chromium screenshot. This is
 * intentionally independent of getComputedStyle: the regression being guarded
 * here was a compositor-level CSS filter that left every internal theme value
 * correct while literally displaying the opposite colours.
 */
function decodeSinglePixelPng (png: Buffer): RGB {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(png.subarray(0, 8).equals(signature), 'theme pixel sample must be a PNG')

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
    if (type === 'IEND') break
  }

  assert.strictEqual(width, 1, 'theme sample screenshot must contain exactly one pixel')
  assert.strictEqual(height, 1, 'theme sample screenshot must contain exactly one pixel')
  assert.strictEqual(bitDepth, 8, 'theme sample PNG must use 8-bit channels')
  assert.ok(colorType === 2 || colorType === 6, `unsupported theme sample PNG colour type ${colorType}`)

  const scanline = inflateSync(Buffer.concat(idat))
  assert.ok(scanline.length >= 4, 'theme sample PNG scanline is truncated')
  // For a one-pixel row every PNG filter has a zero-valued left/up predictor,
  // so the first three channel bytes are the literal RGB value.
  return { r: scanline[1], g: scanline[2], b: scanline[3] }
}

describe('Editor theme enum in the assembled app', function () {
  this.timeout(240_000)

  let appProcess: ChildProcess|undefined
  let browser: Browser|undefined
  let page: Page|undefined
  let preferencesPage: Page|undefined
  let fixtureRoot: string|undefined

  before(async function () {
    const fixture = await createFixture('zettlr-editor-theme-e2e-', {
      documentName: 'theme.md',
      documentContents: '# Theme regression\n\nThe editor must honor the persisted enum on first mount.\n',
      config: {
        // Keep the app itself dark while switching the independent editor enum.
        // This is the exact condition under which a leaked `body.dark` filter
        // inverted the final pixels while CodeMirror's own theme state remained
        // completely correct.
        darkMode: true,
        darkModeEditor: 'dark',
        autoDarkMode: 'off'
      }
    })
    fixtureRoot = fixture.root
    const running = await attach(fixture.configDirectory, [], this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    page = await findEditorPage(browser, this.timeout())

    await page.evaluate(async () => {
      await window.ipc.invoke('application', { command: 'open-preferences' })
    })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && preferencesPage === undefined) {
      preferencesPage = browser
        .contexts()
        .flatMap(context => context.pages())
        .find(candidate => candidate.url().includes('/preferences/'))
      if (preferencesPage === undefined) {
        await page.waitForTimeout(50)
      }
    }
    assert.ok(preferencesPage !== undefined, 'the real Preferences window must open')
    await preferencesPage.getByText('Appearance', { exact: true }).first().click()
    await preferencesPage.locator('select').filter({
      has: preferencesPage.locator('option[value="light"]')
    }).waitFor({ state: 'visible', timeout: 20_000 })
  })

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  async function sample (): Promise<ThemeSample> {
    assert.ok(page !== undefined)
    return await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')
      if (!(scroller instanceof HTMLElement)) {
        throw new Error('CodeMirror scroller is missing')
      }
      const style = getComputedStyle(scroller)
      return {
        appDarkMode: window.config.get('darkMode') as boolean,
        editorMode: window.config.get('darkModeEditor') as 'match'|'light'|'dark',
        bodyDark: document.body.classList.contains('dark'),
        background: style.backgroundColor,
        foreground: style.color
      }
    })
  }

  async function setConfig (key: 'darkMode'|'darkModeEditor', value: boolean|string): Promise<void> {
    assert.ok(page !== undefined)
    await page.evaluate(([ configKey, configValue ]) => {
      window.config.set(configKey, configValue)
    }, [ key, value ] as const)
    await page.waitForTimeout(150)
  }

  async function sampleLiteralEditorPixel (): Promise<RGB> {
    assert.ok(page !== undefined)
    const scroller = page.locator('.cm-scroller')
    const box = await scroller.boundingBox()
    assert.ok(box !== null, 'CodeMirror scroller must have a rendered box')
    // The fixture has only two short lines. Sample near the lower middle of the
    // scroller, well away from authored text, gutters, caret and scrollbars.
    const png = await page.screenshot({
      type: 'png',
      clip: {
        x: Math.floor(box.x + box.width / 2),
        y: Math.floor(box.y + box.height - 20),
        width: 1,
        height: 1
      }
    })
    return decodeSinglePixelPng(png)
  }

  async function selectEditorTheme (value: 'light'|'dark'): Promise<void> {
    assert.ok(page !== undefined)
    assert.ok(preferencesPage !== undefined)
    const select = preferencesPage.locator('select').filter({
      has: preferencesPage.locator('option[value="light"]')
    })
    await select.selectOption(value)
    await page.waitForFunction(
      expected => window.config.get('darkModeEditor') === expected,
      value
    )
    // Wait for the actual compositor frame, not merely the config event.
    await page.waitForTimeout(50)
  }

  it('keeps light/dark enum semantics at cold mount and during live switching', async function () {
    assert.deepStrictEqual(await sample(), {
      appDarkMode: true,
      editorMode: 'dark',
      bodyDark: true,
      background: 'rgb(43, 43, 44)',
      foreground: 'rgb(240, 240, 240)'
    })
    assert.deepStrictEqual(
      await sampleLiteralEditorPixel(),
      { r: 43, g: 43, b: 44 },
      'Dark Theme must literally paint the dark editor colour'
    )

    await selectEditorTheme('light')
    assert.deepStrictEqual(await sample(), {
      appDarkMode: true,
      editorMode: 'light',
      bodyDark: true,
      background: 'rgb(255, 255, 255)',
      foreground: 'rgb(80, 80, 90)'
    })
    assert.deepStrictEqual(
      await sampleLiteralEditorPixel(),
      { r: 255, g: 255, b: 255 },
      'Light Theme must literally paint a white editor background'
    )

    await selectEditorTheme('dark')
    assert.deepStrictEqual(await sample(), {
      appDarkMode: true,
      editorMode: 'dark',
      bodyDark: true,
      background: 'rgb(43, 43, 44)',
      foreground: 'rgb(240, 240, 240)'
    })
    assert.deepStrictEqual(
      await sampleLiteralEditorPixel(),
      { r: 43, g: 43, b: 44 },
      'switching back to Dark Theme must literally restore the dark RGB'
    )

    // The third enum value retains its independent contract as well.
    await setConfig('darkModeEditor', 'match')
    assert.deepStrictEqual(await sample(), {
      appDarkMode: true,
      editorMode: 'match',
      bodyDark: true,
      background: 'rgb(43, 43, 44)',
      foreground: 'rgb(240, 240, 240)'
    })

    await setConfig('darkMode', false)
    assert.deepStrictEqual(await sample(), {
      appDarkMode: false,
      editorMode: 'match',
      bodyDark: false,
      background: 'rgb(255, 255, 255)',
      foreground: 'rgb(80, 80, 90)'
    })
  })
})

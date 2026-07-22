/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Mod-P reference search overlay probe specs (issue #1, Phase 3b red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real ReferenceSearchOverlay Vue component in
 *                  Chromium (webpack renderer bundle, xvfb Electron, real
 *                  keyboard input) against a workspace snapshot extracted
 *                  from the reference-workspace fixture. Locks the Mod-P
 *                  search contract: typing a fuzzy query surfaces the
 *                  matching workspace definition rows, and Enter emits the
 *                  jump intent for the selected definition. While the
 *                  component does not exist, the probe reports that as
 *                  structured data and every spec here fails on assertions.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface JumpIntent {
  key: string
  documentPath: string
  range: { from: number, to: number }
}

interface OverlayProbeResult {
  componentAvailable: boolean
  componentFailure: string|null
  expectedIntent: JumpIntent|null
  query: string|null
  rows: Array<{ key: string|null, documentPath: string|null, text: string }>
  jumpIntents: JumpIntent[]
  screenshots: string[]
}

const THEOREMS_RELATIVE = path.join('ProjectA', 'Theorems.md')

describe('Mod-P reference search overlay', function () {
  let outputDirectory: string
  let result: OverlayProbeResult

  before(async function () {
    this.timeout(240000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-reference-search-'))
    const root = process.cwd()
    await execFileAsync('node', [
      path.join(root, 'test/reference-search-overlay-build.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync('xvfb-run', [
      '-a',
      path.join(root, 'node_modules/.bin/electron'),
      '--ozone-platform=x11',
      '--disable-gpu',
      // A fresh yarn install leaves electron's chrome-sandbox without its
      // root-owned SUID bits, which aborts Chromium under xvfb. The probe
      // renders local test content only, so run unsandboxed rather than
      // requiring sudo provisioning for the test suite.
      '--no-sandbox',
      path.join(root, 'test/reference-search-overlay-probe.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const jsonLine = stdout.trim().split('\n').at(-1)
    assert.ok(jsonLine !== undefined, 'the overlay probe must return its observed result object')
    result = JSON.parse(jsonLine) as OverlayProbeResult
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('mounts the ReferenceSearchOverlay component from source/win-main', function () {
    assert.equal(
      result.componentFailure,
      null,
      `the Mod-P overlay component must exist and mount: ${result.componentFailure ?? ''}`
    )
    assert.equal(result.componentAvailable, true, 'the overlay must report a successful mount')
  })

  it('typing kodemb narrows the workspace definitions to lem:kodaira:embedding', function () {
    assert.equal(result.query, 'kodemb', 'real keyboard input must land in the autofocused query input')
    assert.equal(
      result.rows.length,
      1,
      `kodemb matches exactly one workspace definition key, got rows: ${JSON.stringify(result.rows)}`
    )
    assert.equal(result.rows[0].key, 'lem:kodaira:embedding')
    assert.ok(
      result.rows[0].documentPath !== null && result.rows[0].documentPath.endsWith(THEOREMS_RELATIVE),
      `the row must name the defining document, got: ${String(result.rows[0].documentPath)}`
    )
    assert.ok(
      result.rows[0].text.includes('lem:kodaira:embedding'),
      'the row must display the authored key'
    )
  })

  it('Enter emits the jump intent for the selected definition', function () {
    // Independent oracle for the expected intent: the definition range spans
    // exactly the authored '#lem:kodaira:embedding' id token (typed-model
    // contract), so recompute it directly from the fixture source.
    const fixturePath = path.join('test', 'fixtures', 'reference-workspace', THEOREMS_RELATIVE)
    const source = readFileSync(fixturePath, 'utf-8')
    const idToken = '#lem:kodaira:embedding'
    const expectedFrom = source.indexOf(idToken)
    assert.ok(expectedFrom >= 0, 'the fixture must author the kodaira lemma id token')

    assert.ok(result.expectedIntent !== null, 'the probe must compute the expected intent from real extraction')
    assert.equal(result.expectedIntent.key, 'lem:kodaira:embedding')
    assert.ok(result.expectedIntent.documentPath.endsWith(THEOREMS_RELATIVE))
    assert.deepEqual(
      result.expectedIntent.range,
      { from: expectedFrom, to: expectedFrom + idToken.length },
      'the extracted range must span exactly the authored id token'
    )

    assert.equal(
      result.jumpIntents.length,
      1,
      'Enter on the selected row must emit exactly one jump intent'
    )
    assert.deepEqual(
      result.jumpIntents[0],
      result.expectedIntent,
      'the emitted jump intent must target the selected definition'
    )
  })
})

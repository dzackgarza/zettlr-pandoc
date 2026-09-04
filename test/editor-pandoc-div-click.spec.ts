/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Real-layout Pandoc fenced-div click regression tests
 * CVM-Role:        Test
 * License:         GNU GPL v3
 *
 * Description:     Sends real Chromium mouse input to the production
 *                  CodeMirror renderer and verifies source-position mapping.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface ClickResult {
  kind: 'text'|'gutter'|'label'
  side?: 'left'|'right'
  text: string
  expectedFrom: number
  expectedTo: number
  expectedAtCoords: number|null
  hitTag: string|null
  actual: number
}

describe('Pandoc fenced-div clicks preserve CodeMirror source positions', function () {
  let outputDirectory: string
  let results: ClickResult[]

  before(async function () {
    this.timeout(120000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-pandoc-div-click-'))
    const root = process.cwd()
    await execFileAsync(path.join(root, 'node_modules/.bin/esbuild'), [
      path.join(root, 'test/editor-pandoc-div-click-entry.ts'),
      '--bundle',
      '--platform=browser',
      '--format=iife',
      `--tsconfig=${path.join(root, 'tsconfig.json')}`,
      `--outfile=${path.join(outputDirectory, 'pandoc-div-click-bundle.js')}`,
    ])
    const { stdout } = await execFileAsync('xvfb-run', [
      '-a',
      'node',
      path.join(root, 'test/editor-pandoc-div-click-probe.mjs'),
      outputDirectory,
    ], { maxBuffer: 1024 * 1024 })
    const jsonLine = stdout.trim().split('\n').at(-1)
    assert.ok(jsonLine !== undefined, 'the Chromium click probe must return its observed cursor positions')
    results = JSON.parse(jsonLine) as ClickResult[]
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  for (const text of [ 'alpha', 'omega', 'gamma', 'delta' ]) {
    it(`maps a click on ${text} inside an inactive div to that authored token`, function () {
      const result = results.find(candidate => candidate.kind === 'text' && candidate.text === text)
      assert.ok(result !== undefined, `missing Chromium click result for ${text}`)
      assert.ok(result.expectedAtCoords !== null, `CodeMirror must resolve the visible ${text} coordinate`)
      assert.ok(
        result.expectedAtCoords >= result.expectedFrom && result.expectedAtCoords <= result.expectedTo,
        `CodeMirror resolved visible ${text} to ${result.expectedAtCoords}, outside [${result.expectedFrom}, ${result.expectedTo}]`
      )
      assert.ok(
        result.actual >= result.expectedFrom && result.actual <= result.expectedTo,
        `clicking ${text} at source [${result.expectedFrom}, ${result.expectedTo}] placed the cursor at ${result.actual}`
      )
    })
  }

  for (const text of [ 'Before outside.', 'Between outside.', 'After outside target.' ]) {
    it(`keeps ordinary text ${text} correctly mapped as a control`, function () {
      const result = results.find(candidate => candidate.kind === 'text' && candidate.text === text)
      assert.ok(result !== undefined, `missing Chromium outside-control result for ${text}`)
      assert.ok(result.expectedAtCoords !== null, `CodeMirror must resolve the visible outside-control coordinate for ${text}`)
      assert.ok(
        result.expectedAtCoords >= result.expectedFrom && result.expectedAtCoords <= result.expectedTo,
        `CodeMirror resolved outside control ${text} to ${result.expectedAtCoords}, outside [${result.expectedFrom}, ${result.expectedTo}]`
      )
      assert.ok(
        result.actual >= result.expectedFrom && result.actual <= result.expectedTo,
        `outside control ${text} at source [${result.expectedFrom}, ${result.expectedTo}] placed the cursor at ${result.actual}`
      )
    })
  }

  for (const label of [ 'Definition', 'Warning' ]) {
    it(`keeps ${label} label activation mapped to its authored opening fence`, function () {
      const result = results.find(candidate => candidate.kind === 'label' && candidate.text === label)
      assert.ok(result !== undefined, `missing Chromium label result for ${label}`)
      assert.equal(result.hitTag, 'PANDOC-DIV-OPEN-WRAPPER')
      assert.equal(result.actual, result.expectedFrom)
    })
  }

  const contentLines = [
    'First target alpha.',
    'Second target omega.',
    'Third target gamma.',
    'Fourth target delta.',
  ]
  for (const text of contentLines) {
    for (const side of [ 'left', 'right' ] as const) {
      it(`maps the ${side} panel gutter beside ${text} to CodeMirror's position on that authored line`, function () {
        const result = results.find(candidate => candidate.kind === 'gutter' && candidate.side === side && candidate.text === text)
        assert.ok(result !== undefined, `missing Chromium ${side}-gutter result for ${text}`)
        assert.equal(result.hitTag, 'PANDOC-DIV-WRAPPER', 'the probe must hit panel chrome rather than rendered text')
        assert.ok(result.expectedAtCoords !== null, 'CodeMirror must resolve the panel coordinate')
        assert.ok(
          result.expectedAtCoords >= result.expectedFrom && result.expectedAtCoords <= result.expectedTo,
          `CodeMirror resolved the ${side} gutter beside ${text} to ${result.expectedAtCoords}, outside [${result.expectedFrom}, ${result.expectedTo}]`
        )
        assert.equal(
          result.actual,
          result.expectedAtCoords,
          `the panel handler must preserve CodeMirror's source position for the ${side} gutter beside ${text}`
        )
      })
    }
  }
})

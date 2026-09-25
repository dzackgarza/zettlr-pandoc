import { strict as assert } from 'assert'
import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface ClickState {
  outerAnchor: number
  innerAnchor: number
  outerDoc: string
  innerDoc: string
}

interface ClickResult {
  text: string
  from: number
  to: number
  state: ClickState
}

interface ProbeResult {
  initialOuterAnchor: number
  results: ClickResult[]
  edited: ClickState
  clickaway: ClickState
}

describe('YAML Properties nested editor isolates clicks from the Markdown editor', function () {
  let outputDirectory: string
  let result: ProbeResult

  before(async function () {
    this.timeout(120000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-yaml-frontmatter-click-'))
    const root = process.cwd()
    await execFileAsync(path.join(root, 'node_modules/.bin/esbuild'), [
      path.join(root, 'test/editor-yaml-frontmatter-click-entry.ts'),
      '--bundle',
      '--platform=browser',
      '--format=iife',
      `--tsconfig=${path.join(root, 'tsconfig.json')}`,
      `--outfile=${path.join(outputDirectory, 'yaml-frontmatter-click-bundle.js')}`
    ])
    const { stdout } = await execFileAsync('xvfb-run', [
      '-a',
      'node',
      path.join(root, 'test/editor-yaml-frontmatter-click-probe.mjs'),
      outputDirectory
    ], { maxBuffer: 1024 * 1024 })
    const jsonLine = stdout.trim().split('\n').at(-1)
    assert.ok(jsonLine !== undefined)
    result = JSON.parse(jsonLine) as ProbeResult
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('lets the inner YAML editor own pointer placement without moving the outer cursor', function () {
    assert.equal(result.results.length, 4)
    for (const candidate of result.results) {
      assert.equal(
        candidate.state.outerAnchor,
        result.initialOuterAnchor,
        `clicking ${candidate.text} moved the outer Markdown cursor`
      )
      assert.ok(
        candidate.state.innerAnchor >= candidate.from && candidate.state.innerAnchor <= candidate.to,
        `clicking ${candidate.text} placed the nested cursor at ${candidate.state.innerAnchor}, outside ${candidate.from}..${candidate.to}`
      )
    }
  })

  it('writes nested edits back to front matter without turning the outer click into a source jump', function () {
    assert.equal(
      result.edited.outerAnchor,
      result.initialOuterAnchor + ' updated'.length,
      'the outer cursor should map through the front-matter edit and remain at the same body position'
    )
    assert.match(result.edited.innerDoc, /title: Cursor mapping proof updated/)
    assert.match(result.edited.outerDoc, /title: Cursor mapping proof updated/)
    assert.match(result.edited.outerDoc, /# Body\nBody text stays put\./)
  })

  it('commits a pending YAML edit before an immediate outside mousedown reaches CodeMirror', function () {
    assert.match(result.clickaway.outerDoc, /title: Cursor mapping proof updated clickaway/)
    assert.match(result.clickaway.outerDoc, /# Body\nBody text stays put\./)
  })
})

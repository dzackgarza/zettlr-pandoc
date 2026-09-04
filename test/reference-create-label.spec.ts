/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Create-reference-label dialog probe specs (issue #1, Phase 6 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real CreateReferenceLabelDialog Vue component
 *                  and the definition key-edit prompt editor scene in
 *                  Chromium (webpack renderer bundle, xvfb Electron, real
 *                  keyboard input — the reference-search-overlay trio
 *                  harness) against the reference-workspace fixture. Locks
 *                  the workstream-3 creation contract: the dialog fixes the
 *                  family prefix from the invoking context, proposes an
 *                  editable slug, reports the live workspace-uniqueness
 *                  verdict as the user types, and confirming records the
 *                  explicit-label insertion plus the '@prefix:key'
 *                  clipboard payload at the emit seam (clipboard write and
 *                  toast are host-owned). Separately, editing a definition
 *                  id and moving the selection out of the edited range must
 *                  emit exactly one workspace-rename prompt intent
 *                  (declining is host behavior: the edit stays and the
 *                  Phase 4 diagnostics flag stale uses). While the surfaces
 *                  do not exist, the probe reports structured absence and
 *                  every spec here fails on assertions.
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

interface DialogState {
  prefix: string|null
  slug: string|null
  uniqueness: string|null
  confirmDisabled: boolean|null
}

interface CreateIntent {
  key: string
  insertText: string
  clipboardText: string
}

interface KeyEditPromptIntent {
  documentPath: string
  oldKey: string
  newKey: string
  range: { from: number, to: number }
}

interface CreateLabelProbeResult {
  componentAvailable: boolean
  componentFailure: string|null
  initialState: DialogState|null
  narrowedState: DialogState|null
  createIntents: CreateIntent[]
  keyEditPrompt: {
    extensionAvailable: boolean
    extensionFailure: string|null
    promptIntents: KeyEditPromptIntent[]
  }
  screenshots: string[]
}

const THEOREMS_RELATIVE = path.join('ProjectA', 'Theorems.md')

describe('Create-reference-label dialog and key-edit prompt', function () {
  let outputDirectory: string
  let result: CreateLabelProbeResult

  before(async function () {
    this.timeout(240000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-create-label-'))
    const root = process.cwd()
    await execFileAsync('node', [
      path.join(root, 'test/visual-build.cjs'),
      path.join(root, 'test/reference-create-label-entry.ts'),
      'reference-create-label-bundle.js',
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync('xvfb-run', [
      '-a',
      path.join(root, 'node_modules/.bin/electron'),
      '--ozone-platform=x11',
      '--disable-gpu',
      // Same sandbox posture as the reference-search-overlay probe: a fresh
      // A fresh package-manager install leaves chrome-sandbox without SUID bits; the probe
      // renders local test content only.
      '--no-sandbox',
      path.join(root, 'test/reference-create-label-probe.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const jsonLine = stdout
      .trim()
      .split('\n')
      .findLast(line => line.startsWith('{') && line.endsWith('}'))
    assert.ok(jsonLine !== undefined, 'the create-label probe must return its observed result object')
    result = JSON.parse(jsonLine) as CreateLabelProbeResult
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('mounts the CreateReferenceLabelDialog component from source/win-main', function () {
    assert.equal(
      result.componentFailure,
      null,
      `the create-label dialog component must exist and mount: ${result.componentFailure ?? ''}`
    )
    assert.equal(result.componentAvailable, true, 'the dialog must report a successful mount')
  })

  it('fixes the family prefix and reports the taken proposed slug', function () {
    // thm:torelli is defined (twice) in the workspace, so the proposal
    // 'torelli' under the fixed 'thm' family must be reported as taken and
    // confirmation must be blocked.
    assert.deepEqual(
      result.initialState,
      { prefix: 'thm:', slug: 'torelli', uniqueness: 'taken', confirmDisabled: true },
      'the dialog must open with the fixed prefix, the editable proposal, and a live taken verdict'
    )
  })

  it('typing a unique slug flips the verdict to available and unblocks confirmation', function () {
    // Real keyboard input appended '-note': thm:torelli-note is defined
    // nowhere in the workspace.
    assert.deepEqual(
      result.narrowedState,
      { prefix: 'thm:', slug: 'torelli-note', uniqueness: 'available', confirmDisabled: false },
      'the uniqueness verdict must track the authored slug'
    )
  })

  it('Enter records the explicit-label insertion and clipboard payload at the emit seam', function () {
    assert.deepEqual(
      result.createIntents,
      [{
        key: 'thm:torelli-note',
        insertText: '#thm:torelli-note',
        clipboardText: '@thm:torelli-note'
      }],
      'confirming must emit exactly one create intent carrying the label token and the @-reference to copy'
    )
  })

  it('provides the reference-key-edit-prompt editor extension', function () {
    assert.equal(
      result.keyEditPrompt.extensionFailure,
      null,
      `the key-edit prompt extension must exist: ${result.keyEditPrompt.extensionFailure ?? ''}`
    )
    assert.equal(result.keyEditPrompt.extensionAvailable, true)
  })

  it('leaving an edited definition id emits exactly one workspace-rename prompt intent', function () {
    // Independent oracle: the scene edits '#thm:torelli' into
    // '#thm:torelli-v2' inside the real Theorems.md content, so the
    // post-edit token range is recomputable from the raw fixture.
    const source = readFileSync(path.join('test', 'fixtures', 'reference-workspace', THEOREMS_RELATIVE), 'utf-8')
    const from = source.indexOf('#thm:torelli')
    assert.ok(from >= 0, 'the fixture must author the torelli definition id token')

    assert.equal(
      result.keyEditPrompt.promptIntents.length,
      1,
      `one selection departure from one edited id must prompt exactly once, got ${JSON.stringify(result.keyEditPrompt.promptIntents)}`
    )
    const intent = result.keyEditPrompt.promptIntents[0]
    assert.ok(
      intent.documentPath.endsWith(THEOREMS_RELATIVE),
      `the intent must name the edited document, got ${intent.documentPath}`
    )
    assert.equal(intent.oldKey, 'thm:torelli', 'the intent must carry the last-snapshot key')
    assert.equal(intent.newKey, 'thm:torelli-v2', 'the intent must carry the authored replacement key')
    assert.deepEqual(
      intent.range,
      { from, to: from + '#thm:torelli-v2'.length },
      'the range must span exactly the post-edit authored id token'
    )
  })
})

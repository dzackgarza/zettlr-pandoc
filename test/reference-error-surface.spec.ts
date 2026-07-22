/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recoverable reference-error surface probe specs (issue #1, Phase 8 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the workstream-5 recoverable-error contract in
 *                  Chromium (webpack renderer bundle, xvfb Electron, real
 *                  keyboard input — the reference-create-label trio
 *                  harness): a failed reference-provider invocation must
 *                  surface as EXACTLY ONE closable error toast naming the
 *                  failed operation, return the typed { status: 'failed' }
 *                  outcome, never escape as an uncaught error or rejection
 *                  (the uncloseable runtime-error overlay path), dismiss on
 *                  click, and leave the editor fully interactive — real
 *                  typing lands in the document after the dismissal. Today
 *                  the production catch paths log only, so the toast list
 *                  stays empty and every spec below fails on assertions.
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

interface ToastState {
  text: string
  isError: boolean
  dismissLabel: string|null
}

interface ErrorSurfaceProbeResult {
  moduleAvailable: boolean
  moduleFailure: string|null
  outcome: unknown
  toastsAfterFailure: ToastState[]
  dismissPerformed: boolean
  toastsAfterDismiss: ToastState[]
  typedProof: string
  editorText: string
  uncaught: string[]
  screenshots: string[]
}

describe('Recoverable reference-error surface', function () {
  let outputDirectory: string
  let result: ErrorSurfaceProbeResult

  before(async function () {
    this.timeout(240000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-error-surface-'))
    const root = process.cwd()
    await execFileAsync('node', [
      path.join(root, 'test/reference-error-surface-build.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync('xvfb-run', [
      '-a',
      path.join(root, 'node_modules/.bin/electron'),
      '--ozone-platform=x11',
      '--disable-gpu',
      // Same sandbox posture as the reference-search-overlay probe: a fresh
      // yarn install leaves chrome-sandbox without SUID bits; the probe
      // renders local test content only.
      '--no-sandbox',
      path.join(root, 'test/reference-error-surface-probe.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const jsonLine = stdout.trim().split('\n').at(-1)
    assert.ok(jsonLine !== undefined, 'the error-surface probe must return its observed result object')
    result = JSON.parse(jsonLine) as ErrorSurfaceProbeResult
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('provides the recoverable reference-error boundary in source/win-main/util', function () {
    assert.equal(
      result.moduleFailure,
      null,
      `the error boundary must exist and load: ${result.moduleFailure ?? ''}`
    )
    assert.equal(result.moduleAvailable, true, 'the boundary module must report a successful load')
  })

  it('surfaces the forced provider failure as one closable error toast, never an uncaught error', function () {
    // The two halves of the workstream-5 contract, asserted together: the
    // structured surface EXISTS (toast) and the unstructured one does NOT
    // (an escaped rejection is what produces the uncloseable
    // runtime-error overlay).
    assert.deepEqual(
      result.uncaught,
      [],
      `no error or rejection may escape to the window, got: ${JSON.stringify(result.uncaught)}`
    )
    assert.deepEqual(
      result.outcome,
      { status: 'failed' },
      'the failed invocation must return the typed failed outcome — no fabricated data, no partial result'
    )
    assert.equal(
      result.toastsAfterFailure.length,
      1,
      `the failure must surface exactly one toast, got: ${JSON.stringify(result.toastsAfterFailure)}`
    )
    const toast = result.toastsAfterFailure[0]
    assert.equal(toast.isError, true, 'the toast must carry the error severity')
    assert.ok(
      toast.text.includes('Loading workspace references'),
      `the toast must name the failed operation so the user knows what broke, got: ${JSON.stringify(toast.text)}`
    )
    assert.equal(toast.dismissLabel, 'Dismiss', 'the toast must expose its dismiss control')
  })

  it('the toast dismisses on click and leaves no surface behind', function () {
    assert.equal(result.dismissPerformed, true, 'a toast must be present to dismiss (red while no toast surfaces)')
    assert.deepEqual(
      result.toastsAfterDismiss,
      [],
      'dismissing must remove the toast entirely — nothing lingers, nothing blocks'
    )
  })

  it('the editor stays interactive: real typing lands in the document after dismissal', function () {
    assert.equal(result.dismissPerformed, true, 'the interactivity claim is only meaningful after a real dismissal (red while no toast surfaces)')
    assert.ok(
      result.editorText.includes(result.typedProof),
      `keyboard input typed after the dismissal must land in the document, got: ${JSON.stringify(result.editorText)}`
    )
  })
})

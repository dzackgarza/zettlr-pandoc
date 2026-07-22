/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        pandoc-crossref preflight red proofs (issue #1 Phase 7)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the pandoc-crossref side of the startup preflight:
 *
 *                  - pandoc-crossref joins REQUIRED_COMMANDS (it is a hard
 *                    dependency of the export filter chain, never optional).
 *                  - assessCrossrefCompatibility parses the Pandoc version
 *                    pandoc-crossref names in its own --version output
 *                    ("… built with Pandoc vX.Y.Z …") and the installed
 *                    pandoc's version (first line of `pandoc --version`) and
 *                    requires EXACT equality — pandoc-crossref refuses
 *                    mismatched pandoc builds at runtime, so preflight must
 *                    catch the mismatch at boot.
 *                  - crossrefCompatibilityFailure names BOTH versions in its
 *                    failure message (preflight() surfaces it exactly like a
 *                    missing requirement).
 *                  - The executing check (checkCrossrefCompatibility) runs
 *                    the real tools on this machine and reports the same
 *                    versions the tools themselves print.
 *
 *                  Fixture strings are REAL captured outputs of the tools
 *                  provisioned for this fork (pandoc-crossref v0.3.24 /
 *                  pandoc 3.9.0.2); the mismatch case doctors only the
 *                  version number inside the real format. The injectable
 *                  VersionOutputRunner follows preflight.ts's existing
 *                  injection style (showError/exit); the real-execution path
 *                  is proven by the integration case below.
 *
 *                  Kept separate from test/preflight.spec.ts so the existing
 *                  six preflight proofs stay untouched.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  assessCrossrefCompatibility,
  checkCrossrefCompatibility,
  crossrefCompatibilityFailure,
  preflight,
  REQUIRED_COMMANDS,
  type VersionOutputRunner
} from '../source/app/util/preflight'

const execFileAsync = promisify(execFile)

/** Real captured `pandoc-crossref --version` output (this fork's toolchain). */
const CROSSREF_OUTPUT_MATCHING =
  'pandoc-crossref v0.3.24 git commit UNKNOWN (UNKNOWN) built with Pandoc v3.9.0.2, pandoc-types v1.23.1.1 and GHC 9.8.4\n'

/** The same real format naming an OLDER Pandoc build (the mismatch case). */
const CROSSREF_OUTPUT_MISMATCHED =
  'pandoc-crossref v0.3.17 git commit UNKNOWN (UNKNOWN) built with Pandoc v3.6.4, pandoc-types v1.23.1.1 and GHC 9.8.4\n'

/** Real captured `pandoc --version` output (first lines). */
const PANDOC_OUTPUT =
  'pandoc 3.9.0.2\nFeatures: +server +lua\n'

describe('pandoc-crossref preflight compatibility (issue #1 Phase 7)', function () {
  it('registers pandoc-crossref as a hard required command', function () {
    const entry = REQUIRED_COMMANDS.find(requirement => requirement.command === 'pandoc-crossref')
    assert.ok(entry !== undefined, 'REQUIRED_COMMANDS must include pandoc-crossref')
  })

  it('parses matching version outputs as compatible, naming both versions', function () {
    assert.deepStrictEqual(
      assessCrossrefCompatibility(CROSSREF_OUTPUT_MATCHING, PANDOC_OUTPUT),
      {
        status: 'compatible',
        crossrefBuiltWithPandoc: '3.9.0.2',
        pandocVersion: '3.9.0.2'
      }
    )
  })

  it('detects a version mismatch and names both versions', function () {
    assert.deepStrictEqual(
      assessCrossrefCompatibility(CROSSREF_OUTPUT_MISMATCHED, PANDOC_OUTPUT),
      {
        status: 'incompatible',
        crossrefBuiltWithPandoc: '3.6.4',
        pandocVersion: '3.9.0.2'
      }
    )
  })

  it('reports unparseable output instead of assuming compatibility', function () {
    // A pandoc-crossref that runs but never names its Pandoc build cannot be
    // assumed compatible.
    const noVersion = assessCrossrefCompatibility('', PANDOC_OUTPUT)
    assert.strictEqual(noVersion.status, 'unparseable')
    assert.strictEqual(noVersion.crossrefBuiltWithPandoc, undefined)

    const noPandoc = assessCrossrefCompatibility(CROSSREF_OUTPUT_MATCHING, '')
    assert.strictEqual(noPandoc.status, 'unparseable')
    assert.strictEqual(noPandoc.pandocVersion, undefined)
  })

  it('produces a preflight failure naming both versions on mismatch', async function () {
    const runner: VersionOutputRunner = async (command, _args) => {
      return command === 'pandoc-crossref'
        ? { stdout: CROSSREF_OUTPUT_MISMATCHED }
        : { stdout: PANDOC_OUTPUT }
    }

    const failure = await crossrefCompatibilityFailure(runner)
    assert.ok(failure !== null, 'a mismatched toolchain must fail preflight')
    assert.ok(failure.includes('3.6.4'), `the failure must name the version pandoc-crossref was built with: ${JSON.stringify(failure)}`)
    assert.ok(failure.includes('3.9.0.2'), `the failure must name the installed pandoc version: ${JSON.stringify(failure)}`)
  })

  it('executes the real tools and reports the versions they print', async function () {
    // Independent oracles: the test itself runs both tools and derives the
    // expected versions from their real output.
    const { stdout: pandocOut } = await execFileAsync('pandoc', ['--version'])
    const pandocVersion = pandocOut.split('\n')[0].replace(/^pandoc(?:\.exe)?\s+/, '').trim()
    assert.ok(/^\d+[.\d]*$/.test(pandocVersion), `pandoc must print a parseable version: ${JSON.stringify(pandocOut.split('\n')[0])}`)

    const { stdout: crossrefOut } = await execFileAsync('pandoc-crossref', ['--version'])
    // Environment truth on this machine: the provisioned pandoc-crossref is
    // built with exactly the installed pandoc.
    assert.ok(
      crossrefOut.includes(`built with Pandoc v${pandocVersion}`),
      `this machine's pandoc-crossref must be built with the installed pandoc (${pandocVersion}): ${JSON.stringify(crossrefOut)}`
    )

    const result = await checkCrossrefCompatibility()
    assert.strictEqual(result.status, 'compatible')
    assert.strictEqual(result.crossrefBuiltWithPandoc, pandocVersion)
    assert.strictEqual(result.pandocVersion, pandocVersion)
  })

  it('preflight() itself fails the boot on a compatibility mismatch (review C1)', async function () {
    // The boot-gate proof: preflight() must CONSULT the compatibility gate
    // and fold its failure into the missing-requirement surface. Deleting
    // the crossrefFailure() call from preflight() must turn this spec red.
    // Commands and paths are empty so the ONLY failure source is the gate;
    // the gate itself is the real crossrefCompatibilityFailure over the
    // captured mismatched outputs.
    const runner: VersionOutputRunner = async (command, _args) => {
      return command === 'pandoc-crossref'
        ? { stdout: CROSSREF_OUTPUT_MISMATCHED }
        : { stdout: PANDOC_OUTPUT }
    }

    const shown: Array<{ title: string, message: string }> = []
    const exits: number[] = []
    const passed = await preflight(
      (title, message) => { shown.push({ title, message }) },
      (code) => { exits.push(code) },
      [],
      [],
      async () => await crossrefCompatibilityFailure(runner)
    )

    assert.strictEqual(passed, false, 'a mismatched toolchain must fail the boot preflight')
    assert.strictEqual(exits.length, 1, 'preflight must terminate the process exactly once')
    assert.strictEqual(exits[0], 1)
    assert.strictEqual(shown.length, 1, 'preflight must present exactly one fatal message')
    assert.ok(shown[0].message.includes('3.6.4'), `the boot failure must name the version pandoc-crossref was built with: ${JSON.stringify(shown[0].message)}`)
    assert.ok(shown[0].message.includes('3.9.0.2'), `the boot failure must name the installed pandoc version: ${JSON.stringify(shown[0].message)}`)

    // The complementary compatible path: the same boot gate passes silently.
    const compatibleRunner: VersionOutputRunner = async (command, _args) => {
      return command === 'pandoc-crossref'
        ? { stdout: CROSSREF_OUTPUT_MATCHING }
        : { stdout: PANDOC_OUTPUT }
    }
    const cleanPassed = await preflight(
      (title, message) => { shown.push({ title, message }) },
      (code) => { exits.push(code) },
      [],
      [],
      async () => await crossrefCompatibilityFailure(compatibleRunner)
    )
    assert.strictEqual(cleanPassed, true, 'a matching toolchain must boot')
    assert.strictEqual(shown.length, 1, 'no additional message may appear on the clean path')
    assert.strictEqual(exits.length, 1, 'no additional exit may occur on the clean path')
  })
})

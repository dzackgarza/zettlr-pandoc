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
import { extractReferences } from 'source/common/pandoc-util/extract-references'

const execFileAsync = promisify(execFile)

interface JumpIntent {
  key: string
  documentPath: string
  range: { from: number, to: number }
}

interface CitingLocation {
  documentPath: string
  range: { from: number, to: number }
  clusterRaw: string
}

interface KeyedProbeResult {
  componentAvailable: boolean
  componentFailure: string|null
  requestedKey: string
  expectedCitingLocations: CitingLocation[]
  query: string|null
  mode: string|null
  rows: Array<{ documentPath: string|null, from: number|null, text: string }>
  jumpIntents: JumpIntent[]
}

interface OverlayProbeRow {
  key: string|null
  documentPath: string|null
  projectStatus: string|null
  text: string
}

interface OverlayProbeState {
  query: string|null
  helpAffordancePresent: boolean
  rows: OverlayProbeRow[]
}

interface OverlayProbeResult {
  componentAvailable: boolean
  componentFailure: string|null
  expectedIntent: JumpIntent|null
  query: string|null
  rows: OverlayProbeRow[]
  jumpIntents: JumpIntent[]
  initialState: OverlayProbeState
  openHelpCount: number
  keyed: KeyedProbeResult
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

  // ——— Current-Project-first ranking with marked rest (review A3, US-16):
  // the probe feeds the other-Project document FIRST and mounts the overlay
  // with the Theorems.md ranking context, so only the implemented grouping
  // can order the initial (empty-query) rows.
  describe('current-Project ranking and Project markers', function () {
    it('lists every active-Project definition before every other-Project definition', function () {
      const fixtureRoot = path.join('test', 'fixtures', 'reference-workspace')
      const theoremsPath = path.join(fixtureRoot, 'ProjectA', 'Theorems.md')
      const otherPath = path.join(fixtureRoot, 'ProjectB', 'Other_Paper.md')
      // Independent oracle: the real extractor over the two fed documents.
      const theoremsCount = extractReferences(theoremsPath, readFileSync(theoremsPath, 'utf-8')).definitions.length
      const otherCount = extractReferences(otherPath, readFileSync(otherPath, 'utf-8')).definitions.length
      assert.ok(theoremsCount >= 10 && otherCount >= 1, 'the fixture documents must stay representative')

      const rows = result.initialState.rows
      assert.equal(
        rows.length,
        theoremsCount + otherCount,
        'the empty query must list every workspace definition'
      )
      for (const row of rows.slice(0, theoremsCount)) {
        assert.ok(
          row.documentPath !== null && row.documentPath.endsWith(path.join('ProjectA', 'Theorems.md')),
          `every current-Project row must precede the marked rest, got early row from ${String(row.documentPath)}`
        )
      }
      for (const row of rows.slice(theoremsCount)) {
        assert.ok(
          row.documentPath !== null && row.documentPath.endsWith(path.join('ProjectB', 'Other_Paper.md')),
          `other-Project rows must follow the current Project, got late row from ${String(row.documentPath)}`
        )
      }
    })

    it('marks other-Project rows with their Project status and leaves current rows unmarked', function () {
      const rows = result.initialState.rows
      const marked = rows.filter(row => row.projectStatus !== null)
      const unmarked = rows.filter(row => row.projectStatus === null)
      assert.ok(marked.length >= 1 && unmarked.length >= 1, 'both groups must be present in the scene')

      for (const row of marked) {
        assert.equal(row.projectStatus, 'another-project', 'marked rows carry the computed Project status')
        assert.ok(
          row.text.includes('Another Project'),
          `the marker must be visible in the row, got ${JSON.stringify(row.text)}`
        )
        assert.ok(
          row.documentPath !== null && row.documentPath.endsWith(path.join('ProjectB', 'Other_Paper.md')),
          'only other-Project rows may be marked'
        )
      }
      for (const row of unmarked) {
        assert.ok(
          row.documentPath !== null && row.documentPath.endsWith(path.join('ProjectA', 'Theorems.md')),
          'current-Project rows stay unmarked'
        )
      }
    })
  })

  // ——— Quick-help affordance (review A2, US-06): the symbol picker links to
  // the searchable Pandoc quick help.
  describe('quick-help affordance', function () {
    it('exposes the [data-open-help] affordance beside the query input', function () {
      assert.equal(result.initialState.helpAffordancePresent, true, 'the overlay must expose its quick-help link')
    })

    it('a real click on the affordance emits exactly one open-help intent', function () {
      assert.equal(
        result.openHelpCount,
        1,
        'clicking [data-open-help] must emit exactly one open-help event for App.vue to mount PandocQuickHelp'
      )
    })
  })

  // ——— Reverse lookup (issue #1 Phase 8): the definition count badge
  // dispatches openReferenceSearchEffect.of({ key }); the overlay must open
  // pre-keyed on that definition and present its workspace CITING LOCATIONS
  // (occurrence rows with snippets and jump actions), not the definition
  // list. Today the keyed request is dropped along the relay chain and the
  // component knows no citing-locations mode — every spec below fails on
  // assertions.
  describe('badge-keyed reverse lookup', function () {
    it('opening with a key pre-populates the query and enters citing-locations mode', function () {
      assert.equal(result.keyed.componentAvailable, true, `the overlay must mount for the keyed scene: ${result.keyed.componentFailure ?? ''}`)
      assert.equal(
        result.keyed.query,
        result.keyed.requestedKey,
        'the keyed request must pre-populate the query input with the definition key'
      )
      assert.equal(
        result.keyed.mode,
        'citing-locations',
        'a keyed request must open the reverse-lookup mode, not the definition search'
      )
    })

    it('presents every workspace citing location with its authored snippet', function () {
      // Independent oracle: the citing locations computed by the real
      // extractor over the whole fixture workspace. thm:torelli is cited
      // from Halphen_Surfaces.md (inside a bracketed cluster) and
      // Standalone_Notes.md (bare) — and is duplicate-DEFINED across
      // projects, which must not suppress its citing locations.
      const expected = result.keyed.expectedCitingLocations
      assert.equal(
        expected.length,
        2,
        `the fixture cites thm:torelli exactly twice (oracle precondition), got ${JSON.stringify(expected)}`
      )

      assert.deepEqual(
        result.keyed.rows.map(row => ({ documentPath: row.documentPath, from: row.from })),
        expected.map(location => ({ documentPath: location.documentPath, from: location.range.from })),
        'the overlay must list exactly the workspace citing locations, in workspace document order'
      )
      for (const [ index, location ] of expected.entries()) {
        assert.ok(
          result.keyed.rows[index]?.text.includes(location.clusterRaw),
          `row ${index} must show the authored citing snippet ${JSON.stringify(location.clusterRaw)}, got ${JSON.stringify(result.keyed.rows[index]?.text)}`
        )
      }
    })

    it('Enter jumps to the first citing location, not to a definition', function () {
      const expected = result.keyed.expectedCitingLocations
      assert.ok(expected.length > 0, 'oracle precondition: the key must have citing locations')
      assert.deepEqual(
        result.keyed.jumpIntents,
        [{
          key: result.keyed.requestedKey,
          documentPath: expected[0].documentPath,
          range: expected[0].range
        }],
        'the jump intent must carry the OCCURRENCE range of the citing location — reverse lookup navigates to usages, never to the definition row'
      )
    })
  })
})

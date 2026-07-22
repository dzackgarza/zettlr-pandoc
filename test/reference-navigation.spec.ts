/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference navigation probe specs (issue #1, Phase 5 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real editor renderer in Chromium (esbuild
 *                  bundle, xvfb Electron, real mouse input — the
 *                  editor-pandoc-div-click harness with the
 *                  reference-search-overlay sandbox flags) against the
 *                  reference-workspace fixture plus the
 *                  reference-navigation-scene fixture, and locks the Phase 5
 *                  renderer-side navigation contract:
 *
 *                  - edit-first parity: an ordinary click on a reference
 *                    chip reveals the authored source (preview suppression —
 *                    must stay green);
 *                  - captureDocumentLocation returns the exact restorable
 *                    location (selection, scrollTop, folds) at jump time;
 *                  - platform Mod-click on a reference occurrence FOLLOWS
 *                    the definition: same-file jumps select the definition
 *                    id token in the SAME view; cross-file jumps emit the
 *                    documents-provider 'open-file' request carrying the
 *                    definition target range and the captured source
 *                    location;
 *                  - footnotes join the same navigation: ordinary click
 *                    stays edit-first, Mod-click follows to the footnote
 *                    body.
 *
 *                  BOUNDARY SPLIT (stated explicitly, per the red-proof
 *                  contract): this spec proves the RENDERER half only — the
 *                  resolved intent, the captured location, the same-file
 *                  selection follow, and the outgoing open-file request
 *                  recorded at the window.ipc preload seam (the recorder
 *                  never simulates a documents-provider response). The full
 *                  cross-file tab choreography — reusing an existing tab,
 *                  opening and focusing a new one, widened Back/Forward
 *                  history — needs the real documents provider and is locked
 *                  red against the real TabManager in
 *                  test/tab-manager-history.spec.ts. Nothing fakes the
 *                  provider here.
 *
 *                  While the navigation surface is unimplemented
 *                  (util/reference-navigation.ts is an inert skeleton and
 *                  click-listeners.ts has no Citation/Footnote Mod-click
 *                  branch), the probe reports empty/null observations and
 *                  every red spec fails on assertions, not on crashes.
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

interface ProbeSelection { anchor: number, head: number }
interface ProbeRange { from: number, to: number }

interface ExpectedLocation {
  documentPath: string
  selection: ProbeSelection
  scrollTop: number
  folds: ProbeRange[]
}

interface CapturedLocation extends ExpectedLocation {
  sourceGeneration: number
}

interface ProbeInvocation {
  channel: string
  args: Array<{ command?: string, payload?: Record<string, unknown> }>
}

interface ResolvedIntent {
  kind: string
  scope: string
  key: string
  family: string | null
  target: { documentPath: string, range: ProbeRange }
  source: CapturedLocation
}

interface NavigationProbeResult {
  crossFile: {
    parity: {
      chipPresentBefore: boolean
      tokenRange: ProbeRange | null
      selectionAfterChipClick: ProbeSelection | null
      chipSuppressedAfterClick: boolean | null
      rawTokenVisibleAfterClick: boolean | null
    }
    location: {
      foldRange: ProbeRange
      scrollActual: number
      expected: ExpectedLocation
      captured: CapturedLocation | null
    }
    modClick: {
      rawTokenAvailable: boolean
      occurrenceRange: ProbeRange | null
      resolvedIntent: ResolvedIntent | null
      preJumpLocation: ExpectedLocation | null
      invocations: ProbeInvocation[]
      selectionAfter: ProbeSelection | null
    }
  }
  sameFile: {
    footnoteParity: {
      tokenAvailable: boolean
      tokenRange: ProbeRange | null
      selectionAfter: ProbeSelection | null
      invocations: ProbeInvocation[]
    }
    modClickReference: {
      targetAvailable: boolean
      chipPresent: boolean
      resolvedIntent: ResolvedIntent | null
      invocations: ProbeInvocation[]
      selectionAfter: ProbeSelection | null
    }
    modClickFootnote: {
      targetAvailable: boolean
      resolvedIntent: ResolvedIntent | null
      invocations: ProbeInvocation[]
      selectionAfter: ProbeSelection | null
    }
  }
  screenshots: string[]
}

const THEOREMS_RELATIVE = path.join('ProjectA', 'Theorems.md')
const HALPHEN_RELATIVE = path.join('ProjectA', 'Halphen_Surfaces.md')

describe('Reference navigation (issue #1 Phase 5)', function () {
  let outputDirectory: string
  let result: NavigationProbeResult
  // Independent oracles recomputed from the authored fixture sources.
  const theoremsSource = readFileSync(path.join('test', 'fixtures', 'reference-workspace', THEOREMS_RELATIVE), 'utf-8')
  const sceneSource = readFileSync(path.join('test', 'fixtures', 'reference-navigation-scene.md'), 'utf-8')

  const torelliIdToken = '#thm:torelli'
  const torelliIdFrom = theoremsSource.indexOf(torelliIdToken)
  const torelliIdRange = { from: torelliIdFrom, to: torelliIdFrom + torelliIdToken.length }

  const localIdToken = '#thm:local'
  const localIdFrom = sceneSource.indexOf(localIdToken)
  const localIdRange = { from: localIdFrom, to: localIdFrom + localIdToken.length }

  const footnoteBody = '[^note]: The footnote body clarifies the reduction step.'
  const footnoteBodyFrom = sceneSource.indexOf(footnoteBody)
  const footnoteBodyRange = { from: footnoteBodyFrom, to: footnoteBodyFrom + footnoteBody.length }

  before(async function () {
    this.timeout(240000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-reference-navigation-'))
    const root = process.cwd()
    await execFileAsync(path.join(root, 'node_modules/.bin/esbuild'), [
      path.join(root, 'test/reference-navigation-entry.ts'),
      '--bundle',
      '--platform=browser',
      '--format=iife',
      // clickListeners() branches on process.platform for the Mod key.
      '--define:process.platform="linux"',
      `--tsconfig=${path.join(root, 'tsconfig.json')}`,
      `--outfile=${path.join(outputDirectory, 'reference-navigation-bundle.js')}`,
    ])
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
      path.join(root, 'test/reference-navigation-probe.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    const jsonLine = stdout.trim().split('\n').at(-1)
    assert.ok(jsonLine !== undefined, 'the navigation probe must return its observed result object')
    result = JSON.parse(jsonLine) as NavigationProbeResult
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('has valid fixture oracles', function () {
    assert.ok(torelliIdFrom >= 0, 'Theorems.md must author the #thm:torelli id token')
    assert.ok(localIdFrom >= 0, 'the scene fixture must author the #thm:local id token')
    assert.ok(footnoteBodyFrom >= 0, 'the scene fixture must author the [^note] footnote body')
  })

  describe('edit-first parity (must stay green)', function () {
    it('ordinary click on a resolved chip reveals the authored source', function () {
      const parity = result.crossFile.parity
      assert.equal(parity.chipPresentBefore, true, 'the resolved @tbl:coble-lattices occurrence must render a chip')
      assert.ok(parity.tokenRange !== null && parity.selectionAfterChipClick !== null)
      assert.ok(
        parity.selectionAfterChipClick.anchor >= parity.tokenRange.from &&
        parity.selectionAfterChipClick.anchor <= parity.tokenRange.to,
        `clicking the chip must place the selection inside the authored token [${parity.tokenRange.from}, ${parity.tokenRange.to}], got ${parity.selectionAfterChipClick.anchor}`
      )
      assert.equal(parity.chipSuppressedAfterClick, true, 'the clicked chip must un-render (preview suppression)')
      assert.equal(parity.rawTokenVisibleAfterClick, true, 'the authored @tbl:coble-lattices source must become visible')
    })

    it('ordinary click on a footnote stays edit-first and never navigates', function () {
      const parity = result.sameFile.footnoteParity
      assert.equal(parity.tokenAvailable, true, 'the [^note] token must be visible in the scene document')
      assert.ok(parity.tokenRange !== null && parity.selectionAfter !== null)
      assert.ok(
        parity.selectionAfter.anchor >= parity.tokenRange.from &&
        parity.selectionAfter.anchor <= parity.tokenRange.to,
        `an ordinary footnote click must place the cursor inside [${parity.tokenRange.from}, ${parity.tokenRange.to}], got ${parity.selectionAfter.anchor}`
      )
      assert.equal(parity.invocations.length, 0, 'an ordinary footnote click must not emit any provider request')
    })
  })

  describe('DocumentLocation capture at jump time (red)', function () {
    it('the probe scene produced a nontrivial fold and scroll to capture', function () {
      // Harness sanity that keeps the capture assertion discriminating: the
      // independently read expectation must contain the real fold and the
      // real scroll offset.
      const location = result.crossFile.location
      assert.deepEqual(location.expected.folds, [ location.foldRange ], 'the folded paragraph must appear in the live fold set')
      assert.ok(location.scrollActual > 0, 'the scene must genuinely scroll so the capture assertion is discriminating')
      assert.equal(location.expected.scrollTop, location.scrollActual, 'the live expectation must read the real scroll offset')
      assert.ok(location.expected.documentPath.endsWith(HALPHEN_RELATIVE))
    })

    it('captureDocumentLocation returns the exact restorable location', function () {
      const location = result.crossFile.location
      assert.ok(
        location.captured !== null,
        'Phase 5: captureDocumentLocation must return the restorable location (the skeleton returns null)'
      )
      assert.deepEqual(
        {
          documentPath: location.captured.documentPath,
          selection: location.captured.selection,
          scrollTop: location.captured.scrollTop,
          folds: location.captured.folds
        },
        location.expected,
        'the captured location must match the independently read selection, scroll offset, and folds exactly'
      )
      assert.ok(
        Number.isInteger(location.captured.sourceGeneration) && location.captured.sourceGeneration >= 0,
        'the captured location must carry an integer source generation'
      )
    })
  })

  describe('cross-file Mod-click follow (red)', function () {
    it('resolves the navigation intent for @thm:torelli with the definition’s exact range', function () {
      const modClick = result.crossFile.modClick
      assert.equal(modClick.rawTokenAvailable, true, 'the authored @thm:torelli token must be reachable for the Mod-click')
      assert.ok(
        modClick.resolvedIntent !== null,
        'Phase 5: resolveReferenceNavigationIntent must resolve the Citation occurrence (the skeleton returns null)'
      )
      assert.equal(modClick.resolvedIntent.kind, 'reference')
      assert.equal(modClick.resolvedIntent.scope, 'cross-file')
      assert.equal(modClick.resolvedIntent.key, 'thm:torelli')
      assert.equal(modClick.resolvedIntent.family, 'thm')
      assert.ok(
        modClick.resolvedIntent.target.documentPath.endsWith(THEOREMS_RELATIVE),
        `the intent must target the defining document, got: ${modClick.resolvedIntent.target.documentPath}`
      )
      assert.deepEqual(
        modClick.resolvedIntent.target.range,
        torelliIdRange,
        'the intent must span exactly the authored #thm:torelli id token'
      )
    })

    it('emits the documents-provider open-file request with target range and source location', function () {
      const modClick = result.crossFile.modClick
      assert.equal(
        modClick.invocations.length,
        1,
        'Phase 5: a cross-file Mod-click must emit exactly one open-file request at the ipc seam (currently none is emitted)'
      )
      const invocation = modClick.invocations[0]
      assert.equal(invocation.channel, 'documents-provider')
      assert.equal(invocation.args[0]?.command, 'open-file')
      const payload = invocation.args[0]?.payload ?? {}
      assert.ok(
        typeof payload.path === 'string' && payload.path.endsWith(THEOREMS_RELATIVE),
        `the open-file request must name the defining document, got: ${String(payload.path)}`
      )
      assert.deepEqual(
        payload.targetRange,
        torelliIdRange,
        'the request must carry the definition target range so the opened document lands on the definition'
      )
      assert.ok(modClick.preJumpLocation !== null)
      const sourceLocation = payload.sourceLocation as CapturedLocation | undefined
      assert.ok(sourceLocation !== undefined, 'the request must carry the source DocumentLocation captured at jump time')
      assert.deepEqual(
        {
          documentPath: sourceLocation.documentPath,
          selection: sourceLocation.selection,
          scrollTop: sourceLocation.scrollTop,
          folds: sourceLocation.folds
        },
        modClick.preJumpLocation,
        'Back must be able to restore exactly the pre-jump selection, scroll offset, and folds'
      )
    })
  })

  describe('same-file Mod-click follow (red)', function () {
    it('follows @thm:local to its definition inside the same view, without leaving the pane', function () {
      const modClick = result.sameFile.modClickReference
      assert.equal(modClick.targetAvailable, true, 'the @thm:local occurrence must be reachable for the Mod-click')
      assert.ok(
        modClick.resolvedIntent !== null,
        'Phase 5: resolveReferenceNavigationIntent must resolve the same-file occurrence (the skeleton returns null)'
      )
      assert.equal(modClick.resolvedIntent.kind, 'reference')
      assert.equal(modClick.resolvedIntent.scope, 'same-file')
      assert.equal(modClick.resolvedIntent.key, 'thm:local')
      assert.deepEqual(modClick.resolvedIntent.target.range, localIdRange)
      assert.deepEqual(
        modClick.selectionAfter,
        { anchor: localIdRange.from, head: localIdRange.to },
        'a same-file Mod-click must select the definition id token in the SAME view (currently the click behaves like an ordinary cursor move)'
      )
      assert.equal(
        modClick.invocations.length,
        0,
        'a same-file jump must stay in the current tab: no open-file request may leave the pane'
      )
    })
  })

  describe('footnote Mod-click follow (red)', function () {
    it('follows [^note] to the footnote body and keeps the jump in the same document', function () {
      const modClick = result.sameFile.modClickFootnote
      assert.equal(modClick.targetAvailable, true, 'the [^note] token must be reachable for the Mod-click')
      assert.ok(
        modClick.resolvedIntent !== null,
        'Phase 5: resolveReferenceNavigationIntent must resolve the Footnote node (the skeleton returns null)'
      )
      assert.equal(modClick.resolvedIntent.kind, 'footnote')
      assert.equal(modClick.resolvedIntent.scope, 'same-file')
      assert.deepEqual(
        modClick.resolvedIntent.target.range,
        footnoteBodyRange,
        'the intent must span exactly the authored footnote body'
      )
      assert.deepEqual(
        modClick.selectionAfter,
        { anchor: footnoteBodyRange.from, head: footnoteBodyRange.to },
        'a footnote Mod-click must select the footnote body (currently the click behaves like an ordinary cursor move)'
      )
      assert.equal(modClick.invocations.length, 0, 'a footnote jump never leaves the document')
    })
  })
})

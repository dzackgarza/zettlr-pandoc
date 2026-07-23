/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Widget indent-inheritance red proof (issue #15)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the widget-geometry contract against the
 *                  visual-indent trap: visual-indent hangs list markers
 *                  outside the text block by applying a negative
 *                  `text-indent` to the `.cm-line`, and `text-indent` is
 *                  inherited — so any widget renderer whose DOM is a block
 *                  container (`inline-block` math widgets included) has its
 *                  first-line content pulled leftward out of its own box,
 *                  overdrawing whatever precedes it on the line.
 *
 *                  The proof drives the real markdown parser, the
 *                  visual-indent plugin, and the math renderer in Chromium
 *                  (esbuild bundle, xvfb Electron) and measures actual
 *                  bounding boxes: a widget's content must never escape the
 *                  widget's own left edge. jsdom cannot prove this — it has
 *                  no layout.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { execFile } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface WidgetDiagnostics {
  equation: string
  onIndentedLine: boolean
  lineTextIndent: string|null
  containerLeft: number|null
  innerLeft: number|null
  leftEscape: number|null
}

interface SceneDiagnostics {
  indentedLineCount: number
  widgetCount: number
  widgets: WidgetDiagnostics[]
}

const SCENES = [
  'list-math-light-wide',
  'list-math-dark-wide',
  'list-math-light-narrow',
  'quote-div-light',
]

describe('Widget renderers under the visual-indent plugin (issue #15)', function () {
  let outputDirectory: string|undefined
  const diagnostics = new Map<string, SceneDiagnostics>()

  before(async function () {
    this.timeout(240000)
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'zettlr-widget-indent-'))
    const root = process.cwd()
    await execFileAsync(path.join(root, 'node_modules/.bin/esbuild'), [
      path.join(root, 'test/editor-widget-indent-visual-entry.ts'),
      '--bundle',
      '--platform=browser',
      '--format=iife',
      `--tsconfig=${path.join(root, 'tsconfig.json')}`,
      `--outfile=${path.join(outputDirectory, 'widget-indent-visual-bundle.js')}`,
    ])
    await execFileAsync('xvfb-run', [
      '-a',
      path.join(root, 'node_modules/.bin/electron'),
      '--ozone-platform=x11',
      '--disable-gpu',
      // A fresh yarn install leaves electron's chrome-sandbox without its
      // root-owned SUID bits, which aborts Chromium under xvfb. The probe
      // renders local test content only, so run unsandboxed rather than
      // requiring sudo provisioning for the test suite.
      '--no-sandbox',
      path.join(root, 'test/editor-widget-indent-visual-capture.cjs'),
      outputDirectory,
    ], { maxBuffer: 8 * 1024 * 1024 })
    for (const scene of SCENES) {
      const raw = await readFile(path.join(outputDirectory, `${scene}.json`), 'utf8')
      diagnostics.set(scene, JSON.parse(raw) as SceneDiagnostics)
    }
  })

  after(async function () {
    if (outputDirectory !== undefined) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('arms the trap: list scenes render math widgets on visually indented lines', function () {
    for (const scene of SCENES.filter(name => name.startsWith('list-math'))) {
      const observed = diagnostics.get(scene)
      assert.ok(observed !== undefined, `${scene} diagnostics missing`)
      assert.ok(observed.indentedLineCount > 0, `${scene}: no visually indented line`)
      assert.ok(
        observed.widgets.some(widget => widget.onIndentedLine),
        `${scene}: no math widget on an indented line — the proof is vacuous`
      )
      // Both nesting depths must be present (issue acceptance criterion).
      const depths = new Set(observed.widgets
        .filter(widget => widget.onIndentedLine)
        .map(widget => widget.lineTextIndent))
      assert.ok(depths.size >= 2, `${scene}: expected widgets at more than one nesting depth, saw ${[...depths].join(', ')}`)
    }
  })

  it('keeps every widget\'s content inside the widget\'s own box on indented lines', function () {
    for (const scene of SCENES) {
      const observed = diagnostics.get(scene)
      assert.ok(observed !== undefined, `${scene} diagnostics missing`)
      for (const widget of observed.widgets) {
        assert.ok(widget.leftEscape !== null, `${scene}: widget "${widget.equation}" has no measurable content box`)
        assert.ok(
          widget.leftEscape <= 0.5,
          `${scene}: widget "${widget.equation}" escapes its box ${widget.leftEscape.toFixed(2)}px leftward ` +
          `(line text-indent ${widget.lineTextIndent ?? 'none'}) and overdraws the text before it`
        )
      }
    }
  })
})

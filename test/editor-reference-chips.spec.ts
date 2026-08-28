/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference chip rendering red proofs (issue #1 Phase 4)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the reference-chip presentation contract: every
 *                  RESOLVED workspace reference occurrence renders as an
 *                  independent compact `Type — title` chip (fallback
 *                  `Type — key`), authored cluster punctuation, prefixes,
 *                  suffixes, and locators are preserved, mixed
 *                  bibliography/reference clusters stay raw, unresolved
 *                  occurrences stay raw, and no reference ever displays a
 *                  number.
 *
 *                  The takeover differential drives real headless
 *                  EditorViews over the CURRENT render-citations extension
 *                  set and the NEW set (citations renderer + chips renderer):
 *                  bibliography-only clusters must produce byte-identical
 *                  decoration DOM under both sets (the parity MUST-assert),
 *                  while supported-family clusters move from
 *                  render-citations' textual crossref branch to chips.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { forceParsing } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderCitations } from 'source/common/modules/markdown-editor/renderers/render-citations'
import { renderReferenceChips } from 'source/common/modules/markdown-editor/renderers/render-reference-chips'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import { type DocumentReferenceSnapshot } from 'source/types/common/references'

function polyfillJsdomForCodeMirror (): void {
  const w = globalThis as any
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    w.cancelAnimationFrame = (id: any) => clearTimeout(id)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (typeof w.window === 'object') {
      w.window.ResizeObserver = w.ResizeObserver
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }
}

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')

/** The fixture subset whose keys are all unique: every key resolves. */
const RESOLVED_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  'Standalone_Notes.md',
]

/** The complete fixture workspace: thm:torelli duplicates across projects. */
const FULL_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  'Standalone_Notes.md',
  path.join('ProjectB', 'Other_Paper.md'),
]

function fixtureSnapshots (files: string[]): DocumentReferenceSnapshot[] {
  return files.map(relativePath => {
    const documentPath = path.join(FIXTURE_ROOT, relativePath)
    return extractReferences(documentPath, readFileSync(documentPath, 'utf-8'))
  })
}

/**
 * Builds the typed editor payload for a crafted in-test document resolved
 * against the given fixture files.
 */
function payloadFor (doc: string, files: string[]): EditorWorkspaceReferences {
  const snapshot = extractReferences('crafted-editor-buffer.md', doc)
  const workspace = fixtureSnapshots(files).concat([snapshot])
  return {
    snapshot,
    workspaceOccurrences: workspace.flatMap(s => s.occurrences),
    resolutions: resolveWorkspace(workspace)
  }
}

/** Today's citation rendering, exactly as production configures it. */
const CURRENT_SET: () => Extension[] = () => [ markdownParser(), configField, renderCitations ]
/** The Phase-4 set: the citations renderer plus the chips renderer. */
const NEW_SET: () => Extension[] = () => [ markdownParser(), configField, renderCitations, renderReferenceChips, workspaceReferencesField ]

describe('Reference chips (issue #1 Phase 4)', function () {
  const views: EditorView[] = []
  const originalCitationCallback = window.getCitationCallback

  before(function () {
    polyfillJsdomForCodeMirror()
  })

  beforeEach(function () {
    // The deterministic bibliography rendering stub of the citation canary
    // (test/editor-citation-locator-prefix.spec.ts): parity assertions
    // compare the DOM this callback produces under both extension sets.
    window.getCitationCallback = () => citations => citations.map(item => {
      return [ item.id, item.locator, item.suffix?.trimStart() ]
        .filter(part => part !== undefined)
        .join(' ')
    }).join('; ')
  })

  after(function () {
    window.getCitationCallback = originalCitationCallback
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  function createEditor (extensions: Extension[], doc: string, payload?: EditorWorkspaceReferences): EditorView {
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions,
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    if (payload !== undefined) {
      view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })
    }
    views.push(view)
    return view
  }

  function chips (view: EditorView): HTMLElement[] {
    return [ ...view.dom.querySelectorAll<HTMLElement>('.reference-chip') ]
  }

  describe('resolved occurrences render as independent compact chips', function () {
    it('renders a bare untitled occurrence as a Type — key fallback chip', function () {
      const doc = 'The form @eq:intersection-form computes every square.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, RESOLVED_FILES))

      const rendered = chips(view)
      assert.strictEqual(rendered.length, 1, 'the single resolved occurrence must render exactly one chip')
      assert.strictEqual(rendered[0].dataset.referenceKey, 'eq:intersection-form')
      assert.strictEqual(rendered[0].dataset.referenceFamily, 'eq')
      assert.strictEqual(rendered[0].textContent, 'Equation — eq:intersection-form')
      assert.ok(!view.contentDOM.textContent.includes('@eq:intersection-form'), 'the authored token must be replaced by the chip')
    })

    it('renders a titled theorem occurrence as a Type — title chip without any number', function () {
      const doc = 'By @thm:torelli the two surfaces agree.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, RESOLVED_FILES))

      const rendered = chips(view)
      assert.strictEqual(rendered.length, 1)
      assert.strictEqual(rendered[0].dataset.referenceKey, 'thm:torelli')
      assert.strictEqual(rendered[0].dataset.referenceFamily, 'thm')
      assert.strictEqual(rendered[0].textContent, 'Theorem — Torelli for Enriques')
      // Numbering is owned exclusively by export tools and templates: the
      // chip may never display a computed number of any kind.
      assert.ok(!/\d/.test(rendered[0].textContent ?? ''), `the chip must never display a number: ${rendered[0].outerHTML}`)
    })

    it('preserves authored prefixes and punctuation around independent chips in a cluster', function () {
      const doc = 'Recall [see @tbl:coble-lattices; @eq:intersection-form] for the invariants.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, RESOLVED_FILES))

      const rendered = chips(view)
      assert.strictEqual(rendered.length, 2, 'each resolved reference in the cluster must render its own chip')
      assert.deepStrictEqual(
        rendered.map(chip => [ chip.dataset.referenceKey, chip.textContent ]),
        [
          [ 'tbl:coble-lattices', 'Table — Coble lattices of Halphen type' ],
          [ 'eq:intersection-form', 'Equation — eq:intersection-form' ],
        ]
      )

      const cluster = view.dom.querySelector<HTMLElement>('.reference-chip-cluster')
      assert.ok(cluster !== null, 'the cluster renders as one widget wrapping its chips')
      assert.strictEqual(
        cluster.textContent,
        'see Table — Coble lattices of Halphen type; Equation — eq:intersection-form',
        'the authored prefix and separator punctuation must be preserved verbatim around the chips'
      )
    })

    it('preserves authored locators and suffixes after the chip', function () {
      const doc = 'See [@eq:intersection-form, p. 3] for the squares.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, RESOLVED_FILES))

      const cluster = view.dom.querySelector<HTMLElement>('.reference-chip-cluster')
      assert.ok(cluster !== null, 'the bracketed cluster renders as one widget')
      assert.strictEqual(cluster.textContent, 'Equation — eq:intersection-form, p. 3')
      assert.strictEqual(chips(view).length, 1)
    })

    it('takes over the supported-family cluster from render-citations', function () {
      // Today render-citations renders this via its textual crossref branch
      // as 'fig. root-diagram'. Under the NEW set the chips renderer owns it.
      const doc = 'See [@fig:root-diagram] for the roots.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, RESOLVED_FILES))

      const rendered = chips(view)
      assert.strictEqual(rendered.length, 1)
      assert.strictEqual(rendered[0].dataset.referenceKey, 'fig:root-diagram')
      assert.strictEqual(rendered[0].textContent, 'Figure — Root diagram')
      assert.strictEqual(view.dom.querySelectorAll('.citeproc-citation').length, 0, 'a supported-family cluster must not render through the citation widget anymore')
    })
  })

  describe('unresolved occurrences stay raw', function () {
    it('renders no chip for a missing key and keeps the authored source', function () {
      const doc = 'The picture in @fig:nonexistent-diagram is unfinished.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, FULL_FILES))

      assert.strictEqual(chips(view).length, 0, 'a missing reference must not render a chip')
      assert.strictEqual(view.dom.querySelectorAll('.citeproc-citation').length, 0, 'a missing supported-family key must not render through the citation widget')
      assert.ok(view.contentDOM.textContent.includes('@fig:nonexistent-diagram'), 'the authored source must stay raw (diagnostics own missing references)')
    })

    it('renders no chip for a duplicate key and never selects one definition silently', function () {
      // thm:torelli is defined in both ProjectA/Theorems.md and
      // ProjectB/Other_Paper.md in the full fixture workspace.
      const doc = 'The argument in @thm:torelli fails in characteristic two.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, FULL_FILES))

      assert.strictEqual(chips(view).length, 0, 'a duplicate reference must not render a chip')
      assert.strictEqual(view.dom.querySelectorAll('.citeproc-citation').length, 0, 'an unresolved supported-family key must not render through the citation widget')
      assert.ok(view.contentDOM.textContent.includes('@thm:torelli'), 'the authored source must stay raw (diagnostics own duplicates)')
    })
  })

  describe('mixed bibliography/reference clusters', function () {
    it('stays raw under the new extension set', function () {
      const doc = 'Combine [@thm:torelli; @Ols04, Lem. 7.1] for the argument.'
      const view = createEditor(NEW_SET(), doc, payloadFor(doc, RESOLVED_FILES))

      assert.strictEqual(chips(view).length, 0, 'no chip may render inside a mixed cluster')
      assert.strictEqual(view.dom.querySelectorAll('.citeproc-citation').length, 0, 'the mixed cluster must not render through the citation widget')
      assert.ok(
        view.contentDOM.textContent.includes('[@thm:torelli; @Ols04, Lem. 7.1]'),
        'the authored mixed cluster must stay raw (the advisory is a reference-lint diagnostic)'
      )
    })
  })

  describe('bibliography byte-parity (MUST hold in every phase)', function () {
    const bibliographyDocs = [
      'By [@Ols04, Lem. 7.1], some result follows.',
      'See [see @Ols04; @BHPV04] for the surface classification.',
      '@Kod63 says something important about elliptic surfaces.',
      'Smith argues this [-@Kod63] at length.',
    ]

    for (const doc of bibliographyDocs) {
      it(`produces byte-identical citation DOM for ${JSON.stringify(doc)}`, function () {
        const currentView = createEditor(CURRENT_SET(), doc)
        const combinedView = createEditor(NEW_SET(), doc, payloadFor(doc, FULL_FILES))

        const currentWidgets = [ ...currentView.dom.querySelectorAll<HTMLElement>('.citeproc-citation') ]
        const combinedWidgets = [ ...combinedView.dom.querySelectorAll<HTMLElement>('.citeproc-citation') ]

        assert.ok(currentWidgets.length >= 1, 'the parity fixture must actually render a citation widget today')
        assert.deepStrictEqual(
          combinedWidgets.map(widget => widget.outerHTML),
          currentWidgets.map(widget => widget.outerHTML)
        )
        assert.strictEqual(combinedView.contentDOM.textContent, currentView.contentDOM.textContent)
        assert.strictEqual(chips(combinedView).length, 0, 'bibliography clusters must never render chips')
      })
    }
  })
})

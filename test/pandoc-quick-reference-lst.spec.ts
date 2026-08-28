/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        lst crossref family registry specs (issue #1, Phase 8 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the lst (listing) family into the quick-reference
 *                  registry end to end. Issue #1 requires all five explicit
 *                  pandoc-crossref families (fig/tbl/eq/sec/lst); the typed
 *                  model, extractor, resolver, and chips renderer already
 *                  carry lst, but PANDOC_CROSSREF_PREFIXES was deliberately
 *                  left without it (commit 64e8ea96b) because
 *                  isSupportedPandocCrossref feeds render-citations —
 *                  adding lst changes rendering and belongs behind these
 *                  red proofs. Consequences locked here: the registry gap
 *                  itself, the missing listing help example, and the
 *                  field-less render-citations textual branch treating
 *                  @lst references as bibliography citations. The final
 *                  spec is an ALREADY-GREEN end-to-end canary pinning the
 *                  discovered fact that the Phase-4 chips path resolves and
 *                  renders @lst occurrences today — the lst green step must
 *                  close the registry gap without regressing it.
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
import {
  isSupportedPandocCrossref,
  PANDOC_CROSS_REFERENCE_EXAMPLES,
  PANDOC_CROSSREF_PREFIXES
} from 'source/common/util/pandoc-quick-reference'
import { CROSSREF_FAMILIES } from 'source/types/common/references'

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
    if (typeof w.window === 'object') { w.window.ResizeObserver = w.ResizeObserver }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function') {
    w.Range.prototype.getClientRects = () => []
    w.Range.prototype.getBoundingClientRect = () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) })
  }
}

const COBLE_PATH = path.join('test', 'fixtures', 'reference-workspace', 'ProjectA', 'Coble_Lattice_Table.md')

describe('lst crossref family (issue #1 Phase 8)', function () {
  const views: EditorView[] = []
  const originalCitationCallback = window.getCitationCallback

  before(function () {
    polyfillJsdomForCodeMirror()
    // The deterministic bibliography rendering stub of the citation canary
    // (test/editor-citation-locator-prefix.spec.ts): while lst is missing
    // from the crossref registry, the field-less textual branch mistakes
    // @lst references for bibliography citations and routes them here —
    // the assertions below fail on the resulting content, not on a crash.
    window.getCitationCallback = () => citations => citations.map(item => item.id).join('; ')
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

  function createEditor (extensions: Extension[], doc: string): EditorView {
    const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, doc.length, 5000), 'the syntax tree must be fully parsed before asserting')
    views.push(view)
    return view
  }

  it('registers lst in the crossref prefix registry', function () {
    assert.equal(
      isSupportedPandocCrossref('lst:sage-run'),
      true,
      'lst is an issue #1 launch family: lst-prefixed keys must be supported crossrefs'
    )
    assert.deepEqual(
      [ ...PANDOC_CROSSREF_PREFIXES ].sort(),
      [ ...CROSSREF_FAMILIES ].sort(),
      'the quick-reference prefix registry must match the typed model exactly — no family may exist in one and not the other'
    )
  })

  it('exposes a listing example pairing the lst label with the reference that cites it', function () {
    // Structural widening: the example table's const-narrowed prefix union
    // does not include 'lst' until the green step adds the entry — exactly
    // the gap under proof. The runtime assertion is unchanged.
    const examples: ReadonlyArray<{ kind: string, prefix: string, label: string, reference: string }> = PANDOC_CROSS_REFERENCE_EXAMPLES
    const listing = examples.find(example => example.prefix === 'lst')
    assert.ok(listing !== undefined, 'the quick reference must document the listing family alongside fig/tbl/eq/sec')
    assert.equal(listing.kind, 'listing')
    assert.match(listing.label, /\{#lst:key\b/, 'the listing example must author an explicit #lst:key attribute')
    assert.equal(listing.reference, '@lst:key', 'the listing example must cite its own label')
  })

  it('renders @lst references through the textual crossref branch in field-less states', function () {
    // States without workspaceReferencesField (the legacy quick-help
    // harness) keep render-citations' textual crossref branch. The other
    // four families render there; lst must render identically instead of
    // being routed into the bibliography citeproc path.
    const doc = 'See [-@lst:sage-run].\n\noutside'
    const view = createEditor([ markdownParser(), configField, renderCitations ], doc)
    const rendered = view.dom.querySelector<HTMLElement>('.citeproc-citation')
    assert.ok(rendered !== null, 'the cluster must render a citation widget in the field-less state')
    assert.equal(
      rendered.textContent,
      '#sage-run',
      'the suppress-prefix lst reference must render through the textual crossref branch exactly like fig/tbl/eq/sec'
    )
    assert.equal(
      rendered.classList.contains('error'),
      false,
      'an lst reference must never render as a failed bibliography citation'
    )
  })

  it('renders a bracketed empty-slug cluster through the textual branch even WITH the field (review B5/B9)', function () {
    // The deliberate predicate split of render-citations: the takeover gate
    // uses referenceFamilyOf (family + non-empty slug), while the widget's
    // textual branch uses the prefix predicate isSupportedPandocCrossref.
    // A bracketed empty-slug cluster ([-@fig:] parses to the item id
    // 'fig:') is therefore production-reachable in a field-carrying state:
    // it must render as textual crossref content, never as a failed
    // bibliography lookup through the citeproc callback (whose stub here
    // would render the raw id — the discriminating wrong output).
    const doc = 'See [-@fig:].\n\noutside'
    const view = createEditor([ markdownParser(), configField, renderCitations, renderReferenceChips, workspaceReferencesField ], doc)
    const rendered = view.dom.querySelector<HTMLElement>('.citeproc-citation')
    assert.ok(rendered !== null, 'the empty-slug cluster must render a citation widget despite the field being present')
    assert.equal(rendered.textContent, '#', 'the suppress-author empty-slug form renders its textual "#<label>" shape')
    assert.equal(rendered.classList.contains('error'), false, 'the cluster must never surface as a failed bibliography citation')
  })

  it('END-TO-END CANARY (already green): a resolved @lst occurrence renders as a chip', function () {
    // Discovered while authoring the Phase 8 reds: the extractor, resolver,
    // and Phase-4 chips renderer already handle lst end to end — the gap is
    // confined to the quick-reference registry and the field-less textual
    // branch above. This canary pins that end-to-end behavior so the green
    // registry fix cannot regress it.
    const doc = 'Run the computation in @lst:sage-run before the proof.'
    const snapshot = extractReferences('crafted-editor-buffer.md', doc)
    const coble = extractReferences(COBLE_PATH, readFileSync(COBLE_PATH, 'utf-8'))
    const workspace = [ coble, snapshot ]
    const payload: EditorWorkspaceReferences = {
      snapshot,
      workspaceOccurrences: workspace.flatMap(s => s.occurrences),
      resolutions: resolveWorkspace(workspace)
    }

    const view = createEditor(
      [ markdownParser(), configField, renderCitations, renderReferenceChips, workspaceReferencesField ],
      doc
    )
    view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })

    const chips = [ ...view.dom.querySelectorAll<HTMLElement>('.reference-chip') ]
    assert.equal(chips.length, 1, 'the single resolved lst occurrence must render exactly one chip')
    assert.equal(chips[0].dataset.referenceKey, 'lst:sage-run')
    assert.equal(chips[0].dataset.referenceFamily, 'lst')
    assert.equal(
      chips[0].textContent,
      'Listing — Sage session',
      'the chip must show the family display name and the authored caption title'
    )
    assert.ok(!/\d/.test(chips[0].textContent ?? ''), 'the chip must never display a computed number')
  })
})

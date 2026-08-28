/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Create-label confirm-time re-resolution specs (issue #1, Phase 8 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the recompute-at-confirm contract of the prepared
 *                  create-label insertion
 *                  (confirmReferenceLabelInsertion in
 *                  plugins/create-reference-label.ts). The dialog is modal
 *                  only visually: between preparation and confirmation the
 *                  document can shift (content pasted above the target, a
 *                  workspace rename landing, a concurrent label). Confirming
 *                  must therefore re-resolve the target in the CURRENT
 *                  document — yielding the freshly recomputed insertion — or
 *                  report a STRUCTURED stale result, never apply the
 *                  request-time offsets verbatim. Today the host applies the
 *                  prepared offsets unchanged (the recorded Phase 6 gap), so
 *                  every spec here fails on assertions.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import {
  confirmReferenceLabelInsertion,
  resolveCreateReferenceLabelRequest,
  type CreateReferenceLabelRequest
} from 'source/common/modules/markdown-editor/plugins/create-reference-label'
import { extractReferences } from 'source/common/pandoc-util/extract-references'

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

const DIV_OPEN_LINE = '::: {.theorem title="Uniqueness of the model"}'
const DOC = [
  '# Introduction',
  '',
  'Some prose before the target.',
  '',
  DIV_OPEN_LINE,
  'The model is unique.',
  ':::',
  '',
  'More prose after the target.',
  ''
].join('\n')

describe('Create-label confirm-time re-resolution (issue #1 Phase 8)', function () {
  const views: EditorView[] = []

  before(function () {
    polyfillJsdomForCodeMirror()
  })

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy()
    }
    document.body.replaceChildren()
  })

  /** Creates a parsed editor over DOC and prepares the theorem-div request. */
  function prepare (): { view: EditorView, request: CreateReferenceLabelRequest } {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [ markdownParser() ] }),
      parent: document.body
    })
    views.push(view)
    assert.ok(forceParsing(view, DOC.length, 5000), 'the syntax tree must be fully parsed before preparing')

    const request = resolveCreateReferenceLabelRequest(view, DOC.indexOf('The model is unique.'))
    assert.ok(request !== null, 'the unlabeled theorem div must offer a create-label request (preparation precondition)')
    assert.equal(request.family, 'thm', 'the div class fixes the family (preparation precondition)')
    assert.equal(
      request.targetLine,
      DIV_OPEN_LINE,
      'the request must capture the target open line as its confirm-time content anchor'
    )
    return { view, request }
  }

  /** Re-parses after a document-shifting transaction. */
  function reparse (view: EditorView): void {
    assert.ok(forceParsing(view, view.state.doc.length, 5000), 'the syntax tree must be re-parsed after the shift')
  }

  it('re-resolves the shifted target and returns the freshly recomputed insertion', function () {
    const { view, request } = prepare()

    // The document shifts underneath the open dialog: a paragraph lands
    // above the target, displacing every prepared offset.
    const inserted = 'A freshly pasted leading paragraph.\n\n'
    view.dispatch({ changes: { from: 0, to: 0, insert: inserted } })
    reparse(view)

    // Independent oracle: what a fresh preparation against the CURRENT
    // document computes for the same target.
    const fresh = resolveCreateReferenceLabelRequest(view, view.state.doc.toString().indexOf('The model is unique.'))
    assert.ok(fresh !== null, 'the target must still be preparable in the shifted document (oracle precondition)')
    assert.equal(
      fresh.insertion.from,
      request.insertion.from + inserted.length,
      'the oracle insertion must sit exactly one paste-length after the prepared one (oracle precondition)'
    )

    const outcome = confirmReferenceLabelInsertion(view, request)
    assert.deepEqual(
      outcome,
      { status: 'applied', insertion: fresh.insertion },
      'confirming against a shifted document must apply the RECOMPUTED insertion, never the request-time offsets'
    )

    // Semantic end-proof of the recomputed insertion: applying the confirmed
    // intent there yields a document whose extraction carries the new label
    // on the target's own open line.
    assert.ok(outcome.status === 'applied', 'guarded above')
    const { from, to, prefix, suffix } = outcome.insertion
    const labeled = view.state.doc.toString().slice(0, from) +
      `${prefix}#thm:unique-model${suffix}` +
      view.state.doc.toString().slice(to)
    const definition = extractReferences('confirm-scene.md', labeled).definitions.find(d => d.key === 'thm:unique-model')
    assert.ok(definition !== undefined, 'the recomputed insertion must produce an extractable definition')
    const openLineStart = labeled.indexOf('::: {.theorem')
    const openLineEnd = labeled.indexOf('\n', openLineStart)
    assert.ok(
      definition.range.from >= openLineStart && definition.range.to <= openLineEnd,
      `the label must land on the target's open line, got range ${JSON.stringify(definition.range)} for line [${openLineStart}, ${openLineEnd}]`
    )
  })

  it('reports structured staleness when the target was labeled while the dialog was open', function () {
    const { view, request } = prepare()

    // A concurrent actor (second pane, landed workspace rename) labels the
    // very same div while the dialog is open.
    view.dispatch({
      changes: { from: request.insertion.from, to: request.insertion.to, insert: ' #thm:someone-else' }
    })
    reparse(view)

    assert.deepEqual(
      confirmReferenceLabelInsertion(view, request),
      { status: 'stale', reason: 'already-labeled' },
      'confirming onto a target that gained a label must report the structured stale result, never insert a second label'
    )
  })

  it('reports structured staleness when the target no longer exists', function () {
    const { view, request } = prepare()

    // The whole div block is deleted while the dialog is open.
    const divFrom = DOC.indexOf(DIV_OPEN_LINE)
    const divTo = DOC.indexOf(':::', divFrom + DIV_OPEN_LINE.length) + ':::'.length
    view.dispatch({ changes: { from: divFrom, to: divTo, insert: '' } })
    reparse(view)

    assert.deepEqual(
      confirmReferenceLabelInsertion(view, request),
      { status: 'stale', reason: 'target-vanished' },
      'confirming after the target vanished must report the structured stale result, never insert into unrelated text'
    )
  })
})

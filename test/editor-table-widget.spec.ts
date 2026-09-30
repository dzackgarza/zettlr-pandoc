/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table widgets follow the size of a change
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A table widget stays in place while its table is unchanged.
 *                  These tests state what the author sees of that: a table
 *                  below an edit still edits its own cells, the cell that
 *                  holds the cursor is an editor, and a transaction that
 *                  cannot change a table does not render it again.
 *
 * END HEADER
 */

import './provision-renderer-window-seams'
// The renderers -> table-editor -> subview import cycle resolves only in the
// order of the application, which this import establishes.
import 'source/common/modules/markdown-editor/renderers'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { strict as assert } from 'assert'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderTables } from 'source/common/modules/markdown-editor/table-editor'
import { tableDecorations } from 'source/common/modules/markdown-editor/table-editor/widget'
import { configField, getDefaultConfig } from 'source/common/modules/markdown-editor/util/configuration'

type FrameHandle = number | ReturnType<typeof setTimeout>

/** The browser surface CodeMirror measures through and jsdom does not carry. */
interface MeasurableGlobals {
  requestAnimationFrame?: (callback: (time: number) => void) => FrameHandle
  cancelAnimationFrame?: (handle: FrameHandle) => void
  ResizeObserver?: unknown
  window?: MeasurableGlobals
  Range?: { prototype: Partial<Range> }
}

function polyfillJsdomForCodeMirror (): void {
  const w = globalThis as MeasurableGlobals
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)
    w.cancelAnimationFrame = (handle: FrameHandle) => clearTimeout(handle)
  }
  if (typeof w.window === 'object' && typeof w.window.requestAnimationFrame !== 'function') {
    w.window.requestAnimationFrame = w.requestAnimationFrame
    w.window.cancelAnimationFrame = w.cancelAnimationFrame
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    }
    if (typeof w.window === 'object') {
      w.window.ResizeObserver = w.ResizeObserver
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== 'function' && w.Range !== undefined) {
    w.Range.prototype.getClientRects = () => [] as unknown as DOMRectList
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({})
    })
  }
}

const DOC = `Opening paragraph.

| Name  | Value |
|-------|-------|
| alpha | one   |
| beta  | two   |

Middle paragraph.

| Key | Note  |
|-----|-------|
| k   | gamma |

Closing paragraph.
`

function nextFrame (): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 20) })
}

describe('Table widgets follow the size of a change', function () {
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

  function createView (anchor: number): EditorView {
    const config = getDefaultConfig()
    config.renderingMode = 'preview'
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor },
      extensions: [ markdownParser(), configField.init(() => config), renderTables ]
    })
    const view = new EditorView({ state, parent: document.body })
    assert.ok(forceParsing(view, DOC.length, 5000), 'the syntax tree must be fully parsed')
    views.push(view)
    return view
  }

  function tableWidgets (view: EditorView): WidgetType[] {
    const found: WidgetType[] = []
    const cursor = view.state.field(tableDecorations).decorations.iter()
    while (cursor.value !== null) {
      found.push(cursor.value.spec.widget as WidgetType)
      cursor.next()
    }
    return found
  }

  function cellWithText (view: EditorView, text: string): HTMLTableCellElement {
    const cells = [...view.dom.querySelectorAll<HTMLTableCellElement>('td, th')]
    const cell = cells.find(candidate => candidate.textContent?.trim() === text)
    assert.ok(cell !== undefined, `the editor must show a table cell with the text ${text}`)
    return cell
  }

  function click (cell: HTMLTableCellElement): void {
    const Mouse = cell.ownerDocument.defaultView?.MouseEvent
    assert.ok(Mouse !== undefined, 'the document must have a window')
    cell.dispatchEvent(new Mouse('mousedown', { bubbles: true, cancelable: true }))
  }

  it('shows each pipe table as a table', function () {
    const view = createView(0)
    assert.equal(view.dom.querySelectorAll('table').length, 2)
    assert.equal(cellWithText(view, 'gamma').tagName, 'TD')
    assert.equal(cellWithText(view, 'Name').tagName, 'TH')
  })

  it('keeps the tables when the cursor moves through text or text outside a table changes', function () {
    const view = createView(0)
    const before = tableWidgets(view)
    const tables = [...view.dom.querySelectorAll('table')]

    view.dispatch({ selection: { anchor: 5 } })
    view.dispatch({ changes: { from: 0, insert: 'A new first paragraph.\n\n' } })
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'A new last line.\n' } })

    const after = tableWidgets(view)
    assert.equal(after.length, 2)
    assert.ok(after.every((widget, index) => widget === before[index]), 'a table outside the edit keeps its widget')
    assert.deepEqual([...view.dom.querySelectorAll('table')], tables)
  })

  it('puts the cursor into the clicked cell of a table that an earlier edit moved', function () {
    const view = createView(0)
    const inserted = 'A new first paragraph.\n\n'
    view.dispatch({ changes: { from: 0, insert: inserted } })

    click(cellWithText(view, 'gamma'))

    const from = view.state.sliceDoc().indexOf('gamma')
    const anchor = view.state.selection.main.anchor
    assert.ok(anchor >= from && anchor <= from + 'gamma'.length, `the cursor is at ${anchor}, the cell starts at ${from}`)
  })

  it('makes the cell with the cursor an editor and shows the cell again when the cursor leaves', async function () {
    const view = createView(0)
    const position = DOC.indexOf('beta') + 2

    view.dispatch({ selection: { anchor: position } })
    await nextFrame()
    const editing = view.dom.querySelectorAll('td div.content.editing')
    assert.equal(editing.length, 1)
    assert.ok(editing[0].querySelector('.cm-editor') !== null, 'the cell holds an editor')

    view.dispatch({ selection: { anchor: 0 } })
    await nextFrame()
    assert.equal(view.dom.querySelectorAll('td div.content.editing').length, 0)
    assert.equal(cellWithText(view, 'beta').tagName, 'TD')
  })

  it('shows a changed cell of the table that an edit is in', function () {
    const view = createView(0)
    const widgets = tableWidgets(view)
    const position = DOC.indexOf('gamma')

    view.dispatch({ changes: { from: position, to: position + 'gamma'.length, insert: 'delta' } })

    assert.equal(cellWithText(view, 'delta').tagName, 'TD')
    const after = tableWidgets(view)
    assert.equal(after[0], widgets[0], 'the table before the edit keeps its widget')
  })
})

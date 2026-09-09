/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        StatusBar
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The status panel of the code editors (the assets and
 *                  defaults windows): cursor, counts, input mode and
 *                  diagnostics. The main window renders its own status bar
 *                  from the editor's published document info.
 *
 * END HEADER
 */

import { showPanel, EditorView, type Panel } from '@codemirror/view'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { cursorStatus, wordcountStatus, charcountStatus, inputModeStatus } from './info-fields'
import { diagnosticsStatus } from './diagnostics'

/**
 * The interface each item on the statusbar must conform to.
 */
export interface StatusbarItem {
  /**
   * The content (can be HTML, if allowHTML is set to true)
   */
  content: string
  /**
   * A title to be shown on mouseover
   */
  title?: string
  /**
   * If set to true (default: false), content may contain HTML. Use with caution.
   */
  allowHtml?: boolean
  /**
   * An optional handler for when the user clicks on the item. Can, e.g., show
   * a popup menu.
   *
   * @param   {MouseEvent}  event  The mouse event.
   */
  onClick?: (event: MouseEvent) => void
}

/**
 * Use this effect to show or hide the statusbar.
 */
export const showStatusbarEffect = StateEffect.define<boolean>()

/**
 * Creates a new statusbar
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {Panel}             Returns the statusbar panel
 */
function createStatusbar (_view: EditorView): Panel {
  const elem = document.createElement('div')
  elem.className = 'cm-statusbar'
  return {
    top: false,
    dom: elem,
    update (update) {
      const elements: StatusbarItem[] = []
      // NOTE: Order here determines the order in the statusbar
      const items = [
        cursorStatus,
        wordcountStatus,
        charcountStatus,
        inputModeStatus,
        diagnosticsStatus
      ]

      for (const construct of items) {
        const item = construct(update.state, update.view)
        if (item !== null) {
          elements.push(item)
        }
      }

      // Add all elements to the panel
      elem.innerHTML = ''
      for (const element of elements) {
        const span = document.createElement('span')
        if (element.allowHtml === true) {
          span.innerHTML = element.content
        } else {
          span.textContent = element.content
        }
        span.className = 'cm-statusbar-item'
        if (element.onClick !== undefined) {
          span.addEventListener('mousedown', element.onClick)
        }
        if (element.title !== undefined) {
          span.title = element.title
        }
        elem.appendChild(span)
      }
    }
  }
}

const statusbarState = StateField.define<boolean>({
  create: (_state: EditorState) => false,
  update (value, transaction) {
    // Determine if we have to switch our toggle
    for (const effect of transaction.effects) {
      if (effect.is(showStatusbarEffect)) {
        value = effect.value
      }
    }

    return value
  },
  provide: f => showPanel.from(f, display => display ? createStatusbar : null)
})

const statusbarTheme = EditorView.baseTheme({
  '.cm-statusbar': {
    padding: '5px',
    fontSize: '12px',
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    userSelect: 'none',
    cursor: 'default'
  },
  '&dark .cm-statusbar': {
    backgroundColor: '#333',
    color: '#ddd'
  },
  '.cm-statusbar .cm-statusbar-item': {
    padding: '0 5px'
  },
  '.cm-statusbar .cm-statusbar-item:not(:first-child)': {
    borderLeft: '1px solid gray'
  }
})

export const statusbar = [
  statusbarState,
  statusbarTheme
]

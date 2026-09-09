/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Diagnostics Statusbar Item
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file defines the diagnostics statusbar item
 *
 * END HEADER
 */

import { type EditorState } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import { type StatusbarItem } from '.'
import { openLintPanel, closeLintPanel, forEachDiagnostic } from '@codemirror/lint'

/** How many diagnostics of each severity a state carries. */
export interface DiagnosticCounts {
  info: number
  warning: number
  error: number
}

/** Counts the diagnostics of a state by severity. */
export function countDiagnostics (state: EditorState): DiagnosticCounts {
  const counts: DiagnosticCounts = { info: 0, warning: 0, error: 0 }
  forEachDiagnostic(state, (diagnostic, _from, _to) => {
    if (diagnostic.severity === 'info') {
      counts.info++
    } else if (diagnostic.severity === 'warning') {
      counts.warning++
    } else {
      counts.error++
    }
  })
  return counts
}

/**
 * Opens the lint panel, or closes it when it is open. The close is tried
 * first because closeLintPanel() reports false on an already closed panel
 * while openLintPanel() only ever reports true.
 */
export function toggleLintPanel (view: EditorView): boolean {
  if (!closeLintPanel(view)) {
    openLintPanel(view)
  }
  return true
}

/**
 * Displays a count of all diagnostics
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element
 */
export function diagnosticsStatus (state: EditorState, view: EditorView): StatusbarItem|null {
  const { info, warning, error } = countDiagnostics(state)

  return {
    content: `<cds-icon shape="help-info"></cds-icon> ${info} <cds-icon shape="warning-standard"></cds-icon> ${warning} <cds-icon shape="times-circle"></cds-icon> ${error}`,
    allowHtml: true,
    title: trans('Toggle diagnostics panel'),
    onClick (_event) {
      toggleLintPanel(view)
    }
  }
}

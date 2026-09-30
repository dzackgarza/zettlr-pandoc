/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Click and Select Utility
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This function can be used by renderers to enable an easy way
 *                  to select the source code behind rendered widgets.
 *
 * END HEADER
 */

import { type EditorView } from '@codemirror/view'
import { selectRenderedSourceRange } from './reveal-rendered-source'

/**
 * A helper function that returns a click-callback that selects the exact source
 * range owned by a rendered replacement widget. The base renderer stamps the
 * length of that range onto the widget DOM when it creates the
 * Decoration.replace range.
 *
 * @param   {EditorView}  view   The editor view
 *
 * @return  {Function}           A callback compatible with mouse events
 */
export default function clickAndSelect (view: EditorView): (event: MouseEvent) => void {
  return function (event: MouseEvent) {
    const { target } = event
    if (!(target instanceof Element)) {
      return
    }

    const sourceOwner = target.closest<HTMLElement>('[data-preview-source-length]')
    if (sourceOwner === null) {
      return
    }

    // The widget holds the length of its source, not its position: the view
    // knows where the widget is now, after every edit before it.
    const from = view.posAtDOM(sourceOwner)
    selectRenderedSourceRange(view, event, from, from + Number(sourceOwner.dataset.previewSourceLength))
  }
}

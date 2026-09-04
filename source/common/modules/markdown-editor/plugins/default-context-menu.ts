/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        defaultContextMenu
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Showws a default context menu that applies for an unspecific
 *                  position within the editor. Widgets may define their own
 *                  context menus as appropriate.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import { defaultMenu } from '../context-menu/default-menu'
import { linkImageMenu } from '../context-menu/link-image-menu'
import { nodeAtPos } from '../util/node-in-selection'
import { NODES } from '../parser/citation-parser'
import { citationMenu } from '../context-menu/citation-menu'
import { requestCreateReferenceLabel, resolveCreateReferenceLabelRequest } from './create-reference-label'

export const defaultContextMenu = EditorView.domEventHandlers({
  contextmenu (event, view) {
    const coords = { x: event.clientX, y: event.clientY }
    // First, determine where we clicked
    const pos = view.posAtCoords(coords)

    if (pos === null) {
      return false // No context menu to show
    }

    const tree = syntaxTree(view.state)

    const maybeLinkNode = nodeAtPos(pos, tree, [ 'URL', 'Link', 'Image', 'LinkReference' ])
    if (maybeLinkNode !== null) {
      // We can show a Link/Image context menu!
      linkImageMenu(view, maybeLinkNode, coords)
      return true
    }

    const citationNode = nodeAtPos(pos, tree, [NODES.CITATION])

    if (citationNode !== null) {
      // We can show a citation menu
      citationMenu(view, coords, citationNode)
      return true
    }

    const extraItems: AnyMenuItem[] = []

    // Selection-anchored annotation composer (M6): checked against the
    // selection BEFORE the word-selection fallback below can turn an empty
    // selection into a non-empty one — a context click with no selection
    // must never offer this command. The composer itself is a DOM
    // CustomEvent on the view's own element, not a CodeMirror StateEffect:
    // MainEditor.vue listens for it on the stable pane wrapper, so this
    // plugin needs no relay wired into the editor core.
    const selection = view.state.selection.main
    if (selection.from !== selection.to) {
      extraItems.unshift({
        label: trans('Annotate for AI…'),
        type: 'normal',
        action () {
          view.dom.dispatchEvent(new CustomEvent('zettlr-annotate-selection', {
            bubbles: true,
            detail: { from: selection.from, to: selection.to }
          }))
        }
      })
    }

    // Node-routed create-label entry (issue #1 Phase 6): a supported,
    // still-unlabeled reference target (theorem-like div, heading, figure
    // image, listing, display math) offers "Create reference label…" on top
    // of the default menu.
    if (resolveCreateReferenceLabelRequest(view, pos) !== null) {
      extraItems.push({
        label: trans('Create reference label…'),
        type: 'normal',
        action () {
          requestCreateReferenceLabel(view, pos)
        }
      })
    }

    // If there is nothing selected, select the word at the coords
    const nothingSelected = view.state.selection.ranges.every(x => x.empty)
    const wordAt = view.state.wordAt(pos)
    if (nothingSelected && wordAt !== null) {
      view.dispatch({ selection: wordAt })
    }

    const node = tree.resolveInner(pos)
    defaultMenu(view, node, coords, extraItems).catch(err => console.error(err))
    return true
  }
})

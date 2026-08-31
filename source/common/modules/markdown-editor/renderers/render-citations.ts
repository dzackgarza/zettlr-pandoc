/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CitationRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer can display and pre-render citations.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNodeRef, type SyntaxNode } from '@lezer/common'
import { WidgetType, type EditorView } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import clickAndSelect from './click-and-select'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { citationMenu } from '../context-menu/citation-menu'
import { configField, type EditorConfiguration } from '../util/configuration'
import { type Citation, NODES, nodeToCiteItem } from '../parser/citation-parser'
import { isSupportedPandocCrossref } from '@common/util/pandoc-quick-reference'
import { referenceFamilyOf, referenceKeyParts } from '@dts/common/references'
import { workspaceReferencesField } from '../plugins/workspace-references-field'

class CitationWidget extends WidgetType {
  constructor (
    readonly citation: Citation,
    readonly rawCitation: string,
    readonly node: SyntaxNode,
    readonly metadata: EditorConfiguration['metadata']
  ) {
    super()
  }

  eq (other: CitationWidget): boolean {
    return other.metadata === this.metadata &&
      this.rawCitation === other.rawCitation &&
      this.citation.composite === other.citation.composite
  }

  toDOM (view: EditorView): HTMLElement {
    const { items } = this.citation
    const hasCrossref = items.every(i => isSupportedPandocCrossref(i.id))

    if (hasCrossref) {
      const elem = document.createElement('span')
      elem.classList.add('citeproc-citation')
      const citationTexts = []
      for (const item of items) {
        const separatorMatch = /^([a-zA-Z0-9]+)([:-])(.*)$/.exec(item.id)
        const type = separatorMatch !== null ? separatorMatch[1] : item.id
        const label = separatorMatch !== null ? separatorMatch[3] : item.id
        if (item.prefix !== undefined) {
          citationTexts.push(`${item.prefix.trimEnd()} #${label}`)
        } else if (item['suppress-author'] === true) {
          citationTexts.push(`#${label}`)
        } else {
          citationTexts.push(`${type}. ${label}`)
        }
      }

      elem.textContent = citationTexts.join('; ')
      elem.addEventListener('click', clickAndSelect(view))

      return elem
    }

    const config = view.state.field(configField).metadata.library
    const library = config === '' ? CITEPROC_MAIN_DB : config
    const callback = window.getCitationCallback(library)
    const renderedCitation = callback(this.citation.items, this.citation.composite)

    const elem = document.createElement('span')
    elem.classList.add('citeproc-citation')
    if (renderedCitation !== undefined) {
      elem.innerHTML = renderedCitation
    } else {
      elem.innerText = this.rawCitation
      elem.classList.add('error')
    }
    elem.addEventListener('click', clickAndSelect(view))
    elem.addEventListener('contextmenu', (event) => {
      const coords = { x: event.clientX, y: event.clientY }
      const pos = view.posAtDOM(elem)
      const currentNode = syntaxTree(view.state).resolveInner(pos, 1)
      citationMenu(view, coords, currentNode)
    })

    return elem
  }

  ignoreEvent (event: Event): boolean {
    return event instanceof MouseEvent
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === NODES.CITATION
}

function createWidget (state: EditorState, node: SyntaxNodeRef): CitationWidget|undefined {
  try {
    const citation = nodeToCiteItem(node.node, state.sliceDoc())
    // Takeover design (issue #1 Phase 4): in a state carrying
    // workspaceReferencesField (every production Markdown editor), a cluster
    // containing a supported reference-family key is not a bibliography
    // citation. All-supported clusters belong to render-reference-chips;
    // mixed clusters are handled by NEITHER renderer (they stay raw and
    // reference-lint owns the advisory). Pure bibliography clusters keep
    // this widget byte-identical. The gate predicate is referenceFamilyOf
    // (family + non-empty slug — the resolvable keys); see the deliberate
    // predicate split documented in CitationWidget.toDOM (review B5).
    const hasWorkspaceReferences = state.field(workspaceReferencesField, false) !== undefined
    if (hasWorkspaceReferences && citation.items.some(item => referenceFamilyOf(item.id) !== undefined)) {
      return undefined
    }
    return new CitationWidget(
      citation,
      state.sliceDoc(node.from, node.to),
      node.node,
      state.field(configField).metadata
    )
  } catch (err) {
    // nodeToCiteItem throws if it is unhappy
    return undefined
  }
}

export const renderCitations = renderBlockWidgets(shouldHandleNode, createWidget)

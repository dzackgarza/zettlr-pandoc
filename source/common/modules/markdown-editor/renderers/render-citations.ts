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

import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNodeRef } from '@lezer/common'
import { syntaxTree } from '@codemirror/language'
import { WidgetType, type EditorView } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import clickAndSelect from './click-and-select'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { citationMenu } from '../context-menu/citation-menu'
import { configField, type EditorConfiguration } from '../util/configuration'
import { type Citation, NODES, nodeToCiteItem } from '../parser/citation-parser'
import { isSupportedPandocCrossref } from '@common/util/pandoc-quick-reference'
import { referenceFamilyOf } from '@dts/common/references'
import { workspaceReferencesField } from '../plugins/workspace-references-field'
import { hashDocumentSource } from '@common/pandoc-util/extract-references'

const sourceHashes = new WeakMap<EditorState, string>()

class CitationWidget extends WidgetType {
  constructor (
    readonly citation: Citation,
    readonly rawCitation: string,
    readonly metadata: EditorConfiguration['metadata'],
    readonly error?: string
  ) {
    super()
  }

  eq (other: CitationWidget): boolean {
    return other.metadata === this.metadata && other.rawCitation === this.rawCitation &&
      other.error === this.error && other.citation.composite === this.citation.composite &&
      JSON.stringify(other.citation.items) === JSON.stringify(this.citation.items)
  }

  toDOM (view: EditorView): HTMLElement {
    if (this.error !== undefined) {
      const elem = document.createElement('span')
      elem.classList.add('citeproc-citation', 'error')
      elem.textContent = this.rawCitation
      elem.title = this.error
      elem.addEventListener('click', clickAndSelect(view))
      return elem
    }
    const { items } = this.citation
    // PREDICATE SPLIT (review B5, deliberate): createWidget's takeover gate
    // uses referenceFamilyOf — a key counts as a workspace reference only
    // with a supported family AND a non-empty slug, because those are the
    // keys the chips renderer can resolve. THIS branch uses the looser
    // prefix predicate isSupportedPandocCrossref (empty slugs included) so
    // that every all-prefix-shaped cluster renders as crossref TEXT instead
    // of being sent to citeproc as a fake bibliography lookup. The branch is
    // production-reachable: a bracketed empty-slug cluster such as
    // `[-@fig:]` parses to the item id 'fig:', which referenceFamilyOf
    // rejects (no slug) but isSupportedPandocCrossref accepts — with the
    // workspaceReferencesField present, such clusters land exactly here.
    // Field-less harness states additionally exercise it for full keys.
    const hasCrossref = items.every(i => isSupportedPandocCrossref(i.id))

    if (hasCrossref) {
      // We're not dealing with a citation, but rather with a crossref-style
      // cross-reference. So we can render it directly. NOTE: We're only
      // supporting all-crossref citations here, not mixed.
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
      let node = syntaxTree(view.state).resolveInner(view.posAtDOM(elem), 1)
      while (node.type.name !== NODES.CITATION && node.parent !== null) node = node.parent
      if (node.type.name === NODES.CITATION) citationMenu(view, coords, node)
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
  const workspace = state.field(workspaceReferencesField, false)
  let citation = nodeToCiteItem(node.node, state.sliceDoc())
  if (workspace !== undefined) {
    // Workspace references belong to reference chips; mixed clusters remain authored text.
    if (citation.items.some(item => referenceFamilyOf(item.id) !== undefined)) return undefined
    if (workspace === null) return undefined
    let sourceHash = sourceHashes.get(state)
    if (sourceHash === undefined) {
      sourceHash = hashDocumentSource(state.sliceDoc())
      sourceHashes.set(state, sourceHash)
    }
    if (workspace.snapshot.sourceHash !== sourceHash) return undefined
    if (workspace.snapshot.citationError !== undefined) {
      return new CitationWidget(citation, citation.source, state.field(configField).metadata, workspace.snapshot.citationError)
    }
    const extracted = workspace.snapshot.citations?.find(candidate => candidate.from === node.from && candidate.to === node.to)
    if (extracted === undefined) return undefined
    citation = extracted
  }
  return new CitationWidget(citation, state.sliceDoc(node.from, node.to), state.field(configField).metadata)
}

export const renderCitations = renderBlockWidgets(shouldHandleNode, createWidget)

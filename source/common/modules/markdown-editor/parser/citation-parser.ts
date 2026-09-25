/**
 * CodeMirror citation adapters over the Pandoc grammar owned by the vendored
 * @lezer/markdown fork. Parsing lives in the fork; this module only converts
 * syntax nodes into citeproc-facing objects and searches an EditorState.
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import {
  citationParser,
  CITATION_NODES as NODES,
  parseCitationLocator,
  parseCitationSuffix,
  type Citation,
  type CiteItem,
  type CSL_LOCATOR_TERM,
} from '@lezer/markdown'

export { citationParser, NODES, parseCitationSuffix }
export type { Citation, CiteItem, CSL_LOCATOR_TERM }

/**
 * Utility function that takes a Citation node and the Markdown source and turns
 * it into valid CiteItems that can be passed to the citeproc library.
 *
 * @param   {SyntaxNode}  node      The Citation node. Function throws an error
 *                                  if the node is malformed.
 * @param   {string}      markdown  The Markdown source.
 *
 * @return  {CiteItem[]}            The citation items.
 */
export function nodeToCiteItem (node: SyntaxNode, markdown: string): Citation {
  if (node.type.name !== 'Citation') {
    throw new Error(`Expected a Citation node, received type ${node.type.name}`)
  }

  const items: CiteItem[] = []

  // Now, enter that node and iterate over its children. Citation nodes are flat
  // so that we can collect them one after another.
  let child = node.firstChild

  // Composite essentially just means an inline citation where the author
  // name(s) is/are part of the sentence [@AuthorYear has said -> Author (Year) has said]
  const composite = child !== null && child.type.name !== NODES.MARK // Mark here implies square bracket open

  let prefix = undefined
  let citekey = undefined
  let locator = undefined
  let label = undefined
  let suffix = undefined
  let suppressAuthor = undefined

  while (child !== null) {
    if (child.type.name === NODES.PREFIX) {
      prefix = markdown.slice(child.from, child.to)
    } else if (child.type.name === NODES.KEY) {
      citekey = markdown.slice(child.from, child.to)
    } else if (child.type.name === NODES.LOCATOR) {
      const parsed = parseCitationLocator(markdown.slice(child.from, child.to))
      locator = parsed.locator
      label = parsed.label
    } else if (child.type.name === NODES.SUFFIX) {
      suffix = markdown.slice(child.from, child.to)
    } else if (child.type.name === NODES.AUTHORFLAG) {
      suppressAuthor = true
    } else if (child.type.name === NODES.MARK && markdown.slice(child.from, child.to) === ';') {
      // A mark can often be ignored, but if it's a semicolon, we have to flush
      // the state into the cite items and reset.
      if (citekey !== undefined) {
        items.push({
          id: citekey,
          locator, prefix, suffix, label,
          'suppress-author': suppressAuthor
        })
      }
      prefix = undefined
      citekey = undefined
      locator = undefined
      label = undefined
      suffix = undefined
      suppressAuthor = undefined
    }

    child = child.nextSibling
  }

  if (citekey !== undefined) {
    items.push({
      id: citekey,
      locator, prefix, suffix, label,
      'suppress-author': suppressAuthor
    })
  }

  return {
    from: node.from, to: node.to,
    source: markdown.slice(node.from, node.to),
    composite, items
  }
}

/**
 * Utility function that extracts all citation nodes from a provided
 * EditorState. Use in conjunction with `nodeToCiteItem` to quickly extract all
 * citations from a document.
 *
 * @param   {EditorState}  state  The EditorState
 *
 * @return  {SyntaxNode[]}        A list of all found Citation nodes.
 */
export function extractCitationNodes (state: EditorState): SyntaxNode[] {
  const nodes: SyntaxNode[] = []

  syntaxTree(state).iterate({
    enter (node) {
      if (node.type.name === NODES.CITATION) {
        nodes.push(node.node)
        return false
      }
    }
  })
  return nodes
}

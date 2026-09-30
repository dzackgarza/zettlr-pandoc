/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Replace Links
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Rewrites the wikilinks of a file, and retargets the links
 *                  after a file or a directory moved
 *
 * END HEADER
 */

import path from 'path'
import { extractASTNodes, markdownToAST } from '../modules/markdown-utils'
import { type ZettelkastenLink } from '../modules/markdown-utils/markdown-ast'
import { splitWikilinkTarget, type WikilinkIndex } from './wikilink-resolution'

/**
 * Rewrites the targets of the wikilinks in a Markdown document. `rewrite`
 * receives each link's target, before its `#` fragment, and returns the new
 * target, or undefined to leave the link as it is. The fragment and the label
 * are kept.
 *
 * @param   {string}   markdown  The document in question.
 * @param   {Function} rewrite   The new target for a link target
 *
 * @return  {string}             The new document
 */
export default function replaceLinks (markdown: string, rewrite: (target: string) => string|undefined): string {
  const ast = markdownToAST(markdown)
  const links = extractASTNodes(ast, 'ZettelkastenLink') as ZettelkastenLink[]

  const replacements: Array<{ from: number, to: number, text: string }> = []
  for (const link of links) {
    const { target, fragment } = splitWikilinkTarget(link.target)
    const replacement = rewrite(target)
    if (replacement === undefined) {
      continue
    }
    replacements.push({
      ...link.targetRange,
      text: fragment === undefined ? replacement : `${replacement}#${fragment}`
    })
  }

  // Apply the replacements back to front, so that each keeps its offsets
  for (const replacement of replacements.sort((a, b) => b.from - a.from)) {
    markdown = markdown.slice(0, replacement.from) + replacement.text + markdown.slice(replacement.to)
  }

  return markdown
}

/** A file or a directory that moved from `from` to `to`. */
export interface PathMove {
  from: string
  to: string
}

/** Where `filePath` is after `move`: moved with it, or where it was. */
export function movedPath (filePath: string, move: PathMove): string {
  if (filePath === move.from) {
    return move.to
  }
  if (filePath.startsWith(move.from + path.sep)) {
    return move.to + filePath.slice(move.from.length)
  }
  return filePath
}

/**
 * The new target of the wikilink `target` in the document that was at
 * `sourcePath` before `move`, or undefined when the link names the same
 * document on both sides of the move. `before` and `after` index the
 * workspace on either side. A link whose document the move changed (a
 * relative path into or out of a moved directory, a name the move made
 * ambiguous or gave to another document) takes the written form of the
 * document it named before.
 */
export function retargetedLink (
  target: string,
  sourcePath: string,
  move: PathMove,
  before: WikilinkIndex,
  after: WikilinkIndex
): string|undefined {
  const previous = before.resolve(target, sourcePath)
  if (previous.status !== 'resolved') {
    return undefined
  }
  const destination = movedPath(previous.path, move)
  const current = after.resolve(target, movedPath(sourcePath, move))
  return current.status === 'resolved' && current.path === destination ? undefined : after.canonical(destination)
}

/**
 * Retargets the links in `markdown`, the text of the document that was at
 * `sourcePath` before `move` (see `retargetedLink`).
 */
export function retargetLinks (
  markdown: string,
  sourcePath: string,
  move: PathMove,
  before: WikilinkIndex,
  after: WikilinkIndex
): string {
  return replaceLinks(markdown, target => retargetedLink(target, sourcePath, move, before, after))
}

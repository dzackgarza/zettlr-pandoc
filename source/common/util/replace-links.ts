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
 *                  to a file that moved
 *
 * END HEADER
 */

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

/**
 * Retargets the links in `markdown`, the text of `sourcePath`, after the file
 * at `from` moved to `to`. `before` and `after` index the workspace on either
 * side of the move. A link that still names the file (by its ID, an alias,
 * the title, or a path suffix the move kept) stays as written; every other
 * link that named it takes the file's new written form.
 */
export function retargetLinks (
  markdown: string,
  sourcePath: string,
  move: { from: string, to: string },
  before: WikilinkIndex,
  after: WikilinkIndex
): string {
  const newTarget = after.canonical(move.to)
  return replaceLinks(markdown, target => {
    const previous = before.resolve(target, sourcePath)
    if (previous.status !== 'resolved' || previous.path !== move.from) {
      return undefined
    }
    const current = after.resolve(target, sourcePath)
    return current.status === 'resolved' && current.path === move.to ? undefined : newTarget
  })
}

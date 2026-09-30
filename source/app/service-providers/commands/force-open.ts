/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ForceOpen command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command forces open a file, or creates it, if desired,
 *                  and opens it afterwards.
 *
 * END HEADER
 */

import type { AppServiceContainer } from 'source/app/app-service-container'
import ZettlrCommand from './zettlr-command'
import { fragmentHeadingIndex, splitWikilinkTarget } from '@common/util/wikilink-resolution'
import { extractASTNodes, markdownToAST } from '@common/modules/markdown-utils'
import type { Heading } from '@common/modules/markdown-utils/markdown-ast'
import { trans } from '@common/i18n-main'

export interface ForceOpenAPI {
  windowId?: string
  leafId?: string
  linkContents: string
  /** The document that contains the link. */
  sourcePath: string
  newTab?: boolean
}

/** The 1-based line of the heading whose text is `fragment`, ignoring case. */
function headingLine (markdown: string, fragment: string): number|undefined {
  const headings = extractASTNodes(markdownToAST(markdown), 'Heading') as Heading[]
  const index = fragmentHeadingIndex(headings, fragment)
  if (index < 0) {
    return undefined
  }
  return markdown.slice(0, headings[index].from).split('\n').length
}

export default class ForceOpen extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, ['force-open'])
  }

  /**
    * Force-Opens a file, after click on internal link
    *
    * @param   {string}        evt      The event name
    * @param   {ForceOpenAPI}  payload  the parameters of the file to be opened
    * @return  {boolean}                Whether the file was successfully opened.
    */
  async run (evt: string, payload: ForceOpenAPI): Promise<void> {
    let { windowId, linkContents, sourcePath, newTab, leafId } = payload

    if (windowId === undefined) {
      windowId = this._app.documents.windowKeys()[0]
    }

    const { target, fragment } = splitWikilinkTarget(linkContents)
    const resolution = this._app.links.resolve(target, sourcePath)

    if (resolution.status === 'resolved') {
      await this._app.documents.openFile(windowId, leafId, resolution.path, newTab)
      if (fragment !== undefined && fragment !== '') {
        const markdown = this._app.documents.readMarkdownBufferContent(resolution.path) ?? await this._app.fsal.readTextFile(resolution.path)
        const line = headingLine(markdown, fragment)
        if (line !== undefined) {
          this._app.windows.jumpToLine(windowId, resolution.path, line)
        }
      }
      return
    }

    if (resolution.status === 'ambiguous') {
      this._app.windows.showErrorMessage(
        trans('The link %s names more than one document', target),
        resolution.candidates.join('\n')
      )
      return
    }

    // A missing link that names a document, not a path, creates that document
    // in the configured directory, if there is one.
    const { customDirectory } = this._app.config.get().zkn
    if (!target.includes('/') && await this._app.fsal.isDir(customDirectory)) {
      // Call the file-new command on the application, which'll do all
      // necessary steps for us.
      await this._app.commands.run('file-new', { windowId, leafId, name: target, path: customDirectory })
    }
  }
}

module.exports = ForceOpen

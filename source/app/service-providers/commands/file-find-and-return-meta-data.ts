/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FileFindAndReturnMetaData command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command finds the absolute path of a file, and returns
 *                  the file's meta data
 *
 * END HEADER
 */

import extractYamlFrontmatter from '@common/util/extract-yaml-frontmatter'
import { type WikilinkResolution } from '@common/util/wikilink-resolution'
import { splitWikilinkTarget } from '@common/util/wikilink-target'
import ZettlrCommand from './zettlr-command'
import type { MDFileDescriptor } from '@dts/common/fsal'
import type { AppServiceContainer } from 'source/app/app-service-container'

const MAX_FILE_PREVIEW_LENGTH = 300
const MAX_FILE_PREVIEW_LINES = 10

function previewTitleGenerator (userConfig: string, descriptor: MDFileDescriptor): string {
  if (userConfig.includes('title')&& descriptor.yamlTitle !== undefined) {
    return descriptor.yamlTitle
  } else if (userConfig.includes('heading') && descriptor.firstHeading !== null) {
    return descriptor.firstHeading
  }
  return descriptor.name
}

export interface FindFileAndReturnMetadataRequest {
  linkContents: string
  /** The document that contains the link. */
  sourcePath: string
}

export type FindFileAndReturnMetadataResult =
  | {
    status: 'resolved'
    title: string
    filePath: string
    previewMarkdown: string
    wordCount: number
    modtime: number
  }
  | Exclude<WikilinkResolution, { status: 'resolved' }>

export default class FilePathFindMetaData extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, ['file-find-and-return-meta-data'])
  }

  /**
   * Resolves a wikilink and returns the preview of the document it names.
   */
  async run (evt: string, arg: FindFileAndReturnMetadataRequest): Promise<FindFileAndReturnMetadataResult> {
    const { target } = splitWikilinkTarget(arg.linkContents)
    const resolution = this._app.links.resolve(target, arg.sourcePath)
    if (resolution.status !== 'resolved') {
      return resolution
    }

    const descriptor = await this._app.fsal.getDescriptorFor(resolution.path)
    if (descriptor.type !== 'file') {
      throw new Error(`The wikilink target ${resolution.path} is not a Markdown file`)
    }

    const markdown = await this._app.fsal.loadAnySupportedFile(descriptor.path)
    const { content } = extractYamlFrontmatter(markdown)
    const lines = content.split('\n')

    let preview = ''
    let i = 0
    const maxPreviewLines = Math.min(lines.length, MAX_FILE_PREVIEW_LINES)
    while (preview.length <= MAX_FILE_PREVIEW_LENGTH && i < maxPreviewLines) {
      const remainingChars = MAX_FILE_PREVIEW_LENGTH - preview.length
      if (lines[i].length <= remainingChars) {
        preview += lines[i] + '\n'
      } else {
        preview += lines[i].slice(0, remainingChars) + '…'
      }
      i++
    }

    return {
      status: 'resolved',
      title: previewTitleGenerator(this._app.config.get().fileNameDisplay, descriptor),
      filePath: descriptor.path,
      previewMarkdown: preview,
      wordCount: descriptor.wordCount,
      modtime: descriptor.modtime
    }
  }
}

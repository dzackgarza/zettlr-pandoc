/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tab text utility
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Returns the display label for an open document tab.
 *
 * END HEADER
 */

import type { OpenDocument } from '@dts/common/documents'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { useConfigStore, useWorkspaceStore } from 'source/pinia'
import type { AnyDescriptor, FileNameDisplay } from 'source/types/common/fsal'

/**
 * Returns an appropriate display title for the provided doc. Doc can be an
 * `OpenDocument` if called from the document tabs component, or any descriptor
 * if you have a descriptor available, or even just a string with the absolute
 * file path. Whatever you pass into this function, it will use the
 * configuration and the type of `doc` to figure out if it's a file, and return
 * the first authored heading, the YAML frontmatter title, or the filename
 * depending on the user configuration. NOTE: Depends on the config store and
 * workspace store, so can only be used in the renderer.
 *
 * @param   {OpenDocument|AnyDescriptor|string}  doc  The document in question.
 *                                                    Can be an `OpenDocument`,
 *                                                    `AnyDescriptor`, or the
 *                                                    absolute path to a file.
 *
 * @return  {string}                                  The display title
 */
export default function getDocumentTitle (
  doc: OpenDocument|AnyDescriptor|string,
  displayOverride?: FileNameDisplay
): string {
  const configStore = useConfigStore()
  const workspaceStore = useWorkspaceStore()
  const config = configStore.config

  const descriptor = typeof doc === 'string'
    ? workspaceStore.descriptorMap.get(doc)
    : workspaceStore.descriptorMap.get(doc.path)

  if (descriptor === undefined) {
    return typeof doc === 'string' ? pathBasename(doc) : pathBasename(doc.path)
  }

  const fileNameDisplay = displayOverride ?? config.fileNameDisplay
  const useTitle = fileNameDisplay.includes('title')
  const useH1 = fileNameDisplay.includes('heading')
  const displayMdExtensions = config.display.markdownFileExtensions

  if (descriptor.type !== 'file') {
    return descriptor.name
  } else if (useTitle && descriptor.yamlTitle !== undefined) {
    return descriptor.yamlTitle
  } else if (useH1 && descriptor.firstHeading != null) {
    return descriptor.firstHeading
  } else if (displayMdExtensions) {
    return descriptor.name
  } else {
    return descriptor.name.replace(descriptor.ext, '')
  }
}

/**
 * Returns the semantic title used for document tabs/window chrome. Unlike the
 * Explorer display preference, this ordering is invariant:
 *
 * YAML title -> first authored heading -> first prose sentence -> filename.
 */
export function getSemanticDocumentTitle (
  doc: OpenDocument|AnyDescriptor|string
): string {
  const workspaceStore = useWorkspaceStore()
  const descriptor = typeof doc === 'string'
    ? workspaceStore.descriptorMap.get(doc)
    : workspaceStore.descriptorMap.get(doc.path)

  if (descriptor === undefined) {
    return typeof doc === 'string' ? pathBasename(doc) : pathBasename(doc.path)
  }

  return getSemanticDescriptorTitle(descriptor)
}

export function getSemanticDescriptorTitle (descriptor: AnyDescriptor): string {

  if (descriptor.type !== 'file') {
    return descriptor.name
  }

  const yamlTitle = descriptor.yamlTitle?.trim()
  if (yamlTitle !== undefined && yamlTitle !== '') {
    return yamlTitle
  }

  const firstHeading = descriptor.firstHeading?.trim()
  if (firstHeading !== undefined && firstHeading !== '') {
    return firstHeading
  }

  const firstSentence = descriptor.firstSentence?.trim()
  if (firstSentence !== undefined && firstSentence !== '') {
    return firstSentence
  }

  return descriptor.name.replace(descriptor.ext, '')
}

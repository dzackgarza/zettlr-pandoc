/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        filterDescriptorChildren
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Constructs a function that can be passed to a filter
 *                  function operating operating on descriptors which will
 *                  ensure that files and folders that should not be displayed
 *                  are filtered out.
 *
 * END HEADER
 */

import { hasImageExt, hasPDFExt, hasMSOfficeExt, hasOpenOfficeExt, hasDataExt, hasMdOrCodeExt, hasExt } from 'source/common/util/file-extention-checks'
import { isDotFile } from 'source/common/util/ignore-path'
import { useConfigStore } from 'source/pinia'
import type { AnyDescriptor } from 'source/types/common/fsal'
import type { ConfigOptions } from 'source/app/service-providers/config/get-config-template'
import { isInsideRoot } from '@common/util/renderer-path-polyfill'

export interface FileManagerFilterRules {
  include: readonly string[]
  exclude: readonly string[]
}

export interface FileManagerVisibilityConfig {
  attachmentExtensions: string[]
  files: ConfigOptions['files']
  fileManager: {
    filters: FileManagerFilterRules
    hiddenDirectories: readonly string[]
    showHiddenDirectories: boolean
  }
}

export function isPathHiddenByDirectory (
  path: string,
  hiddenDirectories: readonly string[]
): boolean {
  return hiddenDirectories.some(hiddenPath => {
    return path === hiddenPath || isInsideRoot(path, hiddenPath)
  })
}

function normalizeExtension (extension: string): string {
  const trimmed = extension.trim().toLowerCase()
  return trimmed === '' || trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function matchesExtension (filePath: string, extension: string): boolean {
  const normalized = normalizeExtension(extension)
  return normalized !== '' && filePath.toLowerCase().endsWith(normalized)
}

export function matchesPermanentFileFilter (
  child: AnyDescriptor,
  rules: FileManagerFilterRules
): boolean {
  if (child.type === 'directory') {
    return true
  }

  const included = rules.include.length === 0 ||
    rules.include.some(extension => matchesExtension(child.path, extension))
  if (!included) {
    return false
  }

  return !rules.exclude.some(extension => matchesExtension(child.path, extension))
}

/**
 * Utility function that can filter the children of a directory descriptor,
 * taking into account various visibility settings from the configuration. Call
 * this function to get a filter-compatible function.
 *
 * @return  {(item: AnyDescriptor) => boolean}The filter function
 */
export function createFileManagerVisibilityFilter (
  config: FileManagerVisibilityConfig
): (item: AnyDescriptor) => boolean {
  const { files, attachmentExtensions, fileManager } = config
  return (child: AnyDescriptor) => {
    if (
      !fileManager.showHiddenDirectories &&
      isPathHiddenByDirectory(child.path, fileManager.hiddenDirectories)
    ) {
      return false
    }

    // Permanent include/exclude rules are the first authority for file
    // visibility. Everything else, including File Treatment, can only further
    // narrow this set.
    if (!matchesPermanentFileFilter(child, fileManager.filters)) {
      return false
    }

    // Filter files based on our settings
    if (child.type === 'directory') {
      return files.dotFiles.showInFilemanager || !isDotFile(child.name)
    }

    // We have to check for hidden files first so they are not
    // included if they end in one of the accepted extensions
    if (isDotFile(child.name)) {
      return files.dotFiles.showInFilemanager
    } else if (hasImageExt(child.path)) {
      return files.images.showInFilemanager
    } else if (hasPDFExt(child.path)) {
      return files.pdf.showInFilemanager
    } else if (hasMSOfficeExt(child.path)) {
      return files.msoffice.showInFilemanager
    } else if (hasOpenOfficeExt(child.path)) {
      return files.openOffice.showInFilemanager
    } else if (hasDataExt(child.path)) {
      return files.dataFiles.showInFilemanager
    } else if (hasMdOrCodeExt(child.path)) {
      return true
    } else {
      return hasExt(child.path, attachmentExtensions) // Any other "other" file should be excluded
    }
  }
}

export function filterDescriptorChildren (): (item: AnyDescriptor) => boolean {
  return createFileManagerVisibilityFilter(useConfigStore().config)
}

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        getBibliographyForDescriptor
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A simple utility function making it easy to retrieve a file's
 *                  citation library.
 *
 * END HEADER
 */

import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import type { CitationDatabase } from '@dts/common/citeproc'
import type { MDFileDescriptor, ProjectSettings } from '@dts/common/fsal'

/**
 * Takes a descriptor and returns the appropriate citation library for it. NOTE:
 * You still have to check whether there is a library loaded, this simply returns
 * a path (or the CITEPROC_MAIN_DB constant).
 *
 * @param   {MDFileDescriptor}  descriptor  The descriptor
 *
 * @return  {string}                        The appropriate library
 */
export function getBibliographyForDescriptor (descriptor: MDFileDescriptor, project: ProjectSettings|null = null): CitationDatabase {
  if (descriptor.frontmatter != null && 'bibliography' in descriptor.frontmatter) {
    const library = descriptor.frontmatter.bibliography

    if (typeof library === 'string' && library.trim() !== '') {
      return library.trim()
    }

    if (Array.isArray(library) && library.length > 0 && library.every((item): item is string => typeof item === 'string')) {
      return library.map(item => item.trim())
    }
  }

  if (project?.manifest.kind === 'quarto' && project.manifest.bibliographies.length > 0) {
    return project.manifest.bibliographies
  }

  return CITEPROC_MAIN_DB
}

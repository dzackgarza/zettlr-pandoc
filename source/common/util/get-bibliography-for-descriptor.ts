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
import type { AnyDescriptor, MDFileDescriptor, ProjectSettings } from '@dts/common/fsal'

/**
 * Resolves the descriptor for a directory path, if it is known.
 */
export type DirectoryLookup = (dirPath: string) => Promise<AnyDescriptor|undefined>

/**
 * Walks up the parent directories of a file and returns the settings of the
 * closest enclosing project, using only the descriptors already in the given
 * map. Returns null if no project is found -- which includes the case where the
 * map is not populated yet (e.g., during boot), so callers that can await IO
 * should use resolveProjectForDescriptor instead.
 *
 * @param   {MDFileDescriptor}            descriptor     The file
 * @param   {Map<string, AnyDescriptor>}  descriptorMap  Known descriptors
 *
 * @return  {ProjectSettings|null}                       The project settings
 */
export function resolveProjectForDescriptorSync (descriptor: MDFileDescriptor, descriptorMap: Map<string, AnyDescriptor>): ProjectSettings|null {
  let directory = descriptorMap.get(descriptor.dir)
  while (directory?.type === 'directory') {
    if (directory.settings.project !== null) {
      return directory.settings.project
    }
    if (directory.dir === directory.path) {
      break
    }
    directory = descriptorMap.get(directory.dir)
  }
  return null
}

/**
 * Same as resolveProjectForDescriptorSync, but falls back to the given lookup
 * for every directory the map does not know yet.
 *
 * @param   {MDFileDescriptor}            descriptor     The file
 * @param   {Map<string, AnyDescriptor>}  descriptorMap  Known descriptors
 * @param   {DirectoryLookup}             lookup         The fallback lookup
 *
 * @return  {Promise<ProjectSettings|null>}              The project settings
 */
export async function resolveProjectForDescriptor (descriptor: MDFileDescriptor, descriptorMap: Map<string, AnyDescriptor>, lookup: DirectoryLookup): Promise<ProjectSettings|null> {
  let directoryPath = descriptor.dir
  while (true) {
    const directory = descriptorMap.get(directoryPath) ?? await lookup(directoryPath)
    if (directory?.type !== 'directory') {
      return null
    }
    if (directory.settings.project !== null) {
      return directory.settings.project
    }
    if (directory.dir === directory.path) {
      return null
    }
    directoryPath = directory.dir
  }
}

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
    const bibliographies = [ ...project.manifest.bibliographies ]
    if (!bibliographies.includes(CITEPROC_MAIN_DB)) {
      bibliographies.push(CITEPROC_MAIN_DB)
    }
    return bibliographies
  }

  return CITEPROC_MAIN_DB
}

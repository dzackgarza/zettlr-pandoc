/**
 * The bibliography files and project root a document is linted against: the
 * same files the citation renderer (citeproc) uses for that document, so the
 * editor's citation previews and Flowmark's missing-citation check read one
 * bibliography.
 */

import path from 'path'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import type FSAL from '@providers/fsal'
import {
  getBibliographyForDescriptor,
  resolveProjectContextForDescriptor
} from '@common/util/get-bibliography-for-descriptor'

export interface DocumentLintAuthority {
  /** Absolute paths of the document's bibliography files. */
  bibliographies: string[]
  projectRoots: string[]
}

/**
 * @param   mainLibrary  The configured main library (`export.cslLibrary`); ''
 *                       when none is configured.
 */
export async function documentLintAuthority (
  fsal: Pick<FSAL, 'getDescriptorFor' | 'getAnyDirectoryDescriptor'>,
  mainLibrary: string,
  documentPath: string
): Promise<DocumentLintAuthority> {
  const descriptor = await fsal.getDescriptorFor(documentPath)
  if (descriptor.type !== 'file') {
    return { bibliographies: mainLibrary === '' ? [] : [mainLibrary], projectRoots: [] }
  }
  const project = await resolveProjectContextForDescriptor(
    descriptor,
    new Map(),
    async dirPath => await fsal.getAnyDirectoryDescriptor(dirPath)
  )
  const library = getBibliographyForDescriptor(descriptor, project?.project ?? null)
  // Relative entries resolve from the document's directory, as MainEditor
  // resolves them for citeproc.
  const bibliographies = (Array.isArray(library) ? library : [ library ])
    .map(entry => entry === CITEPROC_MAIN_DB ? mainLibrary : path.resolve(descriptor.dir, entry))
    .filter(entry => entry !== '')
  return {
    bibliographies,
    projectRoots: project === null ? [] : [project.rootPath]
  }
}

/**
 * Which cross-reference system renders a document. A document in a Quarto
 * project is rendered by Quarto, whose cross-reference IDs use a hyphen
 * (`#tbl-key`); every other document is exported through the ~/.pandoc
 * recipes with pandoc-crossref, whose IDs use a colon (`#tbl:key`).
 */
export type CrossReferenceSystem = 'quarto' | 'pandoc-crossref'

export async function documentCrossReferenceSystem (
  fsal: Pick<FSAL, 'getDescriptorFor' | 'getAnyDirectoryDescriptor'>,
  documentPath: string
): Promise<CrossReferenceSystem> {
  const descriptor = await fsal.getDescriptorFor(documentPath)
  if (descriptor.type !== 'file') {
    return 'pandoc-crossref'
  }
  const project = await resolveProjectContextForDescriptor(
    descriptor,
    new Map(),
    async dirPath => await fsal.getAnyDirectoryDescriptor(dirPath)
  )
  return project?.project.manifest.kind === 'quarto' ? 'quarto' : 'pandoc-crossref'
}

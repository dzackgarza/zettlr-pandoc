/**
 * The bibliography files and project root a document is linted against: the
 * files that the text of the document names in its front matter, else the
 * bibliographies of its Quarto book and the main library, by the rules that
 * the citation renderer (citeproc) follows for that document.
 *
 * Both facts come from the text and the folder of the document, not from its
 * file: a document with unsaved text stays open after its file is removed
 * outside the app, and it keeps its Project.
 */

import { markdownToAST } from "@common/modules/markdown-utils";
import { documentFrontmatter } from "@common/util/document-frontmatter";
import { hasMarkdownExt } from "@common/util/file-extention-checks";
import {
  getBibliographyForDescriptor,
  resolveProjectContextForDirectory,
} from "@common/util/get-bibliography-for-descriptor";
import type { CitationDatabase } from "@dts/common/citeproc";
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import type { CrossReferenceSystem } from "@dts/common/references";
import type FSAL from "@providers/fsal";
import path from "path";

export interface DocumentBibliography {
  /**
   * The citation database of the document for citeproc: absolute paths, and
   * `CITEPROC_MAIN_DB` for the main library.
   */
  database: CitationDatabase;
  /** The root of the Project of the document, or null. */
  projectRoot: string | null;
}

/**
 * The one answer to "which bibliography does this document cite from" (#198).
 * The editor, the print window, the outline, the previews, the Annotations
 * view, the References view, the lint and the PDF export all ask it. A
 * relative entry of the front matter resolves from the folder of the
 * document.
 *
 * @param   text  The text of the document: the buffer of an open document.
 */
export async function documentBibliography(
  fsal: Pick<FSAL, "getAnyDirectoryDescriptor">,
  documentPath: string,
  text: string,
): Promise<DocumentBibliography> {
  if (!hasMarkdownExt(documentPath)) {
    return { database: CITEPROC_MAIN_DB, projectRoot: null };
  }
  const folder = path.dirname(documentPath);
  const project = await resolveProjectContextForDirectory(
    folder,
    new Map(),
    async (dirPath) => await fsal.getAnyDirectoryDescriptor(dirPath),
  );
  const library = getBibliographyForDescriptor(
    { frontmatter: documentFrontmatter(markdownToAST(text)) },
    project === null ? null : project.project,
  );
  const resolve = (entry: string): string =>
    entry === CITEPROC_MAIN_DB ? entry : path.resolve(folder, entry);
  return {
    database: Array.isArray(library) ? library.map(resolve) : resolve(library),
    projectRoot: project === null ? null : project.rootPath,
  };
}

/**
 * The files of a citation database: `CITEPROC_MAIN_DB` is the main library
 * (`export.cslLibrary`), and a main library of '' is no file.
 */
export function bibliographyFiles(database: CitationDatabase, mainLibrary: string): string[] {
  return (Array.isArray(database) ? database : [database])
    .map((entry) => (entry === CITEPROC_MAIN_DB ? mainLibrary : entry))
    .filter((entry) => entry !== "");
}

export interface DocumentLintAuthority {
  /** Absolute paths of the document's bibliography files. */
  bibliographies: string[];
  projectRoots: string[];
}

/**
 * @param   mainLibrary  The configured main library (`export.cslLibrary`); ''
 *                       when none is configured.
 * @param   text         The text that is linted.
 */
export async function documentLintAuthority(
  fsal: Pick<FSAL, "getAnyDirectoryDescriptor">,
  mainLibrary: string,
  documentPath: string,
  text: string,
): Promise<DocumentLintAuthority> {
  const { database, projectRoot } = await documentBibliography(fsal, documentPath, text);
  return {
    bibliographies: bibliographyFiles(database, mainLibrary),
    projectRoots: projectRoot === null ? [] : [projectRoot],
  };
}

/**
 * The cross-reference system of a document: Quarto for a document in a
 * Quarto project, pandoc-crossref for every other document.
 */
export async function documentCrossReferenceSystem(
  fsal: Pick<FSAL, "getAnyDirectoryDescriptor">,
  documentPath: string,
): Promise<CrossReferenceSystem> {
  if (!hasMarkdownExt(documentPath)) {
    return "pandoc-crossref";
  }
  const project = await resolveProjectContextForDirectory(
    path.dirname(documentPath),
    new Map(),
    async (dirPath) => await fsal.getAnyDirectoryDescriptor(dirPath),
  );
  return project?.project.manifest.kind === "quarto" ? "quarto" : "pandoc-crossref";
}

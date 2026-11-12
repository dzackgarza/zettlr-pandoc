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
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import type FSAL from "@providers/fsal";
import path from "path";

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
  if (!hasMarkdownExt(documentPath)) {
    return { bibliographies: mainLibrary === "" ? [] : [mainLibrary], projectRoots: [] };
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
  // Relative entries resolve from the document's directory, as MainEditor
  // resolves them for citeproc.
  const bibliographies = (Array.isArray(library) ? library : [library])
    .map((entry) => (entry === CITEPROC_MAIN_DB ? mainLibrary : path.resolve(folder, entry)))
    .filter((entry) => entry !== "");
  return {
    bibliographies,
    projectRoots: project === null ? [] : [project.rootPath],
  };
}

/**
 * Which cross-reference system renders a document. A document in a Quarto
 * project is rendered by Quarto, whose cross-reference IDs use a hyphen
 * (`#tbl-key`); every other document is exported through the ~/.pandoc
 * recipes with pandoc-crossref, whose IDs use a colon (`#tbl:key`).
 */
export type CrossReferenceSystem = "quarto" | "pandoc-crossref";

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

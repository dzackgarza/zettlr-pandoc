export const CITEPROC_MAIN_DB = "main";

export type CitationDatabase = string | string[];

/** A file that the citation provider needs and could not load. */
export interface CitationResourceProblem {
  /** `style`: the file of `export.cslStyle`. `library`: the file of `export.cslLibrary`. */
  resource: "style" | "library";
  /** The path as the setting names it. */
  path: string;
  /** The cause, as the failed read or the failed parse gave it. */
  cause: string;
}

/** Carries the current `CitationResourceProblem[]` to each window when it changes. */
export const CITEPROC_PROBLEMS_CHANNEL = "citeproc-problems";

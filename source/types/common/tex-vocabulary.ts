/**
 * Flowmark's TeXstudio command index, the file
 * `src/flowmark/data/texstudio-command-index.json` of pandoc-flowmark.
 */
export interface TexstudioCommandIndex {
  schema: 1;
  source: { repository: string; commit: string };
  /** The entries that every document loads. */
  core: string[];
  /** Entry name → the control sequences it declares and the entries it loads. */
  packages: Record<string, { commands: string[]; includes: string[] }>;
}

/**
 * The TeX vocabulary of Flowmark's `tex` lint context: the index, and the
 * entries that the context loads before Flowmark reads a document (the core
 * entries and the closure of the context packages, classes and macro
 * sources).
 */
export interface TexCommandVocabulary {
  index: TexstudioCommandIndex;
  packages: string[];
}

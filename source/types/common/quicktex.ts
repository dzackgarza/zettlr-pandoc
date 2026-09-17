/** Evaluated QuickTeX dictionaries, with Vim keycodes rendered by keytrans(). */
export interface QuickTexCatalogue {
  prose: Record<string, string>
  math: Record<string, string>
  excludeChars: string[]
  sourceFile: string
  diagnostics: string[]
}

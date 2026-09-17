/**
 * One snippet definition loaded from a VS Code `.code-snippets` file.
 *
 * The persisted format is deliberately not a Zettlr format. These fields are
 * the editor-ready projection of VS Code's documented snippet-file schema.
 */
export interface UserSnippet {
  /** Human-readable object key from the `.code-snippets` file. */
  name: string
  /** One or more standard snippet prefixes. */
  prefixes: string[]
  /** TextMate/VS Code snippet body, with multiline arrays joined by newlines. */
  body: string
  /** Optional description shown in completion UI. */
  description?: string
  /** VS Code language-id scopes; empty means global. */
  scopes: string[]
  /** Optional VS Code file-pattern scopes. */
  include: string[]
  exclude: string[]
  /** Source `.code-snippets` filename for diagnostics/UI only. */
  sourceFile: string
}

export interface SnippetFileDiagnostic {
  sourceFile: string
  message: string
}

export interface SnippetCatalogue {
  snippets: UserSnippet[]
  diagnostics: SnippetFileDiagnostic[]
}

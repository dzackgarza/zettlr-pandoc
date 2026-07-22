// Workspace-resolved Pandoc reference types, shared between the main process
// (FSAL-owned saved snapshots) and the renderer (live CodeMirror
// replacements). This is the typed model locked by issue #1.

import { THEOREM_DIV_PREFIXES } from '../../common/util/pandoc-quick-reference'

/**
 * The explicit pandoc-crossref label families supported at launch.
 */
export const CROSSREF_FAMILIES = [ 'fig', 'tbl', 'eq', 'sec', 'lst' ] as const

export type CrossrefFamily = typeof CROSSREF_FAMILIES[number]

/**
 * Theorem-like fenced-div label families, derived from the fixed prefix
 * registry so this model cannot drift from the export theorem filter.
 */
export type TheoremFamily = keyof typeof THEOREM_DIV_PREFIXES

export const THEOREM_FAMILIES = Object.keys(THEOREM_DIV_PREFIXES) as readonly TheoremFamily[]

/**
 * Every supported reference family. Anything else (automatic heading IDs,
 * arbitrary anchors, `table:`-style near-misses) is outside the contract.
 */
export type ReferenceFamily = CrossrefFamily | TheoremFamily

export const REFERENCE_FAMILIES: readonly ReferenceFamily[] = [ ...CROSSREF_FAMILIES, ...THEOREM_FAMILIES ]

/**
 * An exact authored character range within a document's markdown source.
 * `from` is inclusive, `to` is exclusive.
 */
export interface SourceRange {
  from: number
  to: number
}

/**
 * How a definition was authored: an explicit pandoc-crossref attribute id
 * (`{#fig:key}` on a figure, table caption, equation, heading, or listing) or
 * a theorem-like fenced div (`::: {.theorem #thm:key}`). Proof-like divs are
 * never definitions.
 */
export type ReferenceSourceKind = 'crossref-attr' | 'theorem-div'

/**
 * A single authored reference target.
 *
 * Contract details relied upon by the reference specs:
 *
 * - `range` spans the authored id token including its `#` sigil (for
 *   `{#thm:key}` the range covers exactly `#thm:key`).
 * - `title` is the authored `title="…"` attribute for theorem divs, the
 *   caption text for tables, the alt text for figures, the `caption="…"`
 *   attribute for listings, the heading text for sections, and `undefined`
 *   when nothing was authored (equations). The property is always present.
 * - `previewSource` is the bounded authored excerpt shown in hovers: the
 *   complete fenced div block (opening `:::` line through the closing `:::`
 *   line) for theorem divs, the complete fenced code block for listings, and
 *   otherwise the complete authored line bearing the id attribute.
 * - `enclosingSection` is the text of the nearest preceding heading (without
 *   its attribute block), or `undefined` when no heading precedes. The
 *   property is always present.
 */
export interface ReferenceDefinition {
  /** The full authored key, e.g. 'thm:main' (colons inside keys preserved) */
  key: string
  family: ReferenceFamily
  sourceKind: ReferenceSourceKind
  documentPath: string
  range: SourceRange
  title: string | undefined
  previewSource: string
  enclosingSection: string | undefined
  sourceHash: string
}

/**
 * A single authored use of a reference key. Bibliography citations (keys
 * without a supported family prefix, e.g. `[@Ols04, Lem. 7.1]`) are never
 * occurrences.
 *
 * - `range` spans the authored `@key` token including the `@` sigil.
 * - `clusterRaw` is the authored cluster text: the `@key` token itself for
 *   bare occurrences, or the complete bracketed cluster (e.g.
 *   `[@thm:a; @lem:b]`) for bracketed occurrences.
 */
export interface ReferenceOccurrence {
  key: string
  family: ReferenceFamily
  range: SourceRange
  syntaxKind: 'bare' | 'bracketed'
  clusterRaw: string
  documentPath: string
  sourceHash: string
}

/**
 * The workspace resolution outcome for one key. Duplicates always retain
 * every definition and never select one silently.
 */
export type Resolution =
  | { status: 'resolved', definition: ReferenceDefinition }
  | { status: 'missing', candidates?: string[] }
  | { status: 'duplicate', definitions: ReferenceDefinition[] }

/**
 * The complete reference surface of one document. Definitions and
 * occurrences appear in document order. An open editor buffer completely
 * replaces the saved snapshot for the same document.
 */
export interface DocumentReferenceSnapshot {
  documentPath: string
  sourceHash: string
  definitions: ReferenceDefinition[]
  occurrences: ReferenceOccurrence[]
}

/**
 * A restorable location inside a document, used by reference navigation and
 * per-pane Back/Forward history.
 */
export interface DocumentLocation {
  documentPath: string
  /** Primary selection as character offsets */
  selection: { anchor: number, head: number }
  /** Vertical scroll position of the viewport in pixels */
  scrollTop: number
  /** Collapsed fold ranges to restore */
  folds: SourceRange[]
  /** Editor transaction generation the location was captured at */
  sourceGeneration: number
}

/**
 * One previewed text replacement inside a workspace reference edit.
 */
export interface WorkspaceTextEdit {
  documentPath: string
  range: SourceRange
  insert: string
}

/**
 * Conflict outcome of a workspace edit. Any concurrent-content mismatch
 * aborts the whole operation; there are no partial applications.
 */
export type WorkspaceEditConflict =
  | { status: 'clean' }
  | { status: 'conflict', documentPath: string, expectedSourceHash: string, actualSourceHash: string }

/**
 * A previewed, hash-checked, atomic, undoable workspace edit (e.g. a
 * reference rename). Open buffers change through CodeMirror transactions and
 * remain unsaved; closed files change on disk.
 */
export interface WorkspaceReferenceEdit {
  /** The previewed edits, grouped over every affected document */
  edits: WorkspaceTextEdit[]
  /** Expected source hash per affected documentPath; mismatch aborts */
  expectedSourceHashes: Record<string, string>
  /** Documents applied as open-buffer CodeMirror transactions */
  openBufferPaths: string[]
  /** Documents applied as closed-file disk writes */
  closedFilePaths: string[]
  /** The conflict result of the (attempted) application */
  conflict: WorkspaceEditConflict
  /** Inverse edits restoring the pre-edit source of every touched document */
  undo: WorkspaceTextEdit[]
}

// Workspace-resolved Pandoc reference types, shared between the main process
// (FSAL-owned saved snapshots) and the renderer (live CodeMirror
// replacements). This is the typed model locked by issue #1.

import { PANDOC_CROSSREF_PREFIXES, THEOREM_DIV_PREFIXES } from '../../common/util/pandoc-quick-reference'

/**
 * The explicit pandoc-crossref label families supported at launch.
 *
 * AUTHORITY (review B5): the tuple is DERIVED from the quick-reference
 * registry (PANDOC_CROSS_REFERENCE_EXAMPLES -> PANDOC_CROSSREF_PREFIXES),
 * which is the single owner of the crossref family set. The dependency
 * points this way because this module already consumes
 * THEOREM_DIV_PREFIXES from the same registry module; the reverse
 * direction would create an import cycle.
 */
export const CROSSREF_FAMILIES: readonly CrossrefFamily[] = PANDOC_CROSSREF_PREFIXES

export type CrossrefFamily = typeof PANDOC_CROSSREF_PREFIXES[number]

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
 * Returns the supported family of a full reference key, or undefined when the
 * key is structurally not a reference: no colon, an empty remainder after the
 * family (`thm:`), or a family outside the supported registry (`table:`).
 *
 * @param   {string}  key  The full authored key (colons preserved)
 *
 * @return  {ReferenceFamily|undefined}  The family, if supported
 */
export function referenceFamilyOf (key: string): ReferenceFamily|undefined {
  const colon = key.indexOf(':')
  if (colon <= 0 || colon === key.length - 1) {
    return undefined
  }

  const family = key.slice(0, colon)
  return (REFERENCE_FAMILIES as readonly string[]).includes(family)
    ? family as ReferenceFamily
    : undefined
}

/**
 * Display names of the explicit pandoc-crossref label families.
 */
const CROSSREF_FAMILY_DISPLAY: Record<CrossrefFamily, string> = {
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  sec: 'Section',
  lst: 'Listing'
}

/**
 * The display name of a reference family, derived from the fixed theorem
 * prefix registry ('thm' -> 'Theorem') or the crossref family map
 * ('fig' -> 'Figure'). Display names never carry a computed number:
 * numbering is owned exclusively by export tools and templates.
 *
 * @param   {ReferenceFamily}  family  The reference family
 *
 * @return  {string}                   The capitalized display name
 */
export function referenceFamilyDisplayName (family: ReferenceFamily): string {
  const theoremClass = (THEOREM_DIV_PREFIXES as Record<string, string|undefined>)[family]
  if (theoremClass !== undefined) {
    return theoremClass.charAt(0).toUpperCase() + theoremClass.slice(1)
  }

  return CROSSREF_FAMILY_DISPLAY[family as CrossrefFamily]
}

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
  /**
   * The authored classes of the id-bearing attribute block (review B6):
   * `['theorem']` for `::: {.theorem #thm:key}`, empty when the block
   * authors no classes. Carried on the definition so consumers (e.g. the
   * class/prefix mismatch diagnostic) never re-parse previewSource, which
   * is a display excerpt, not a parsing surface.
   */
  classes: string[]
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
 * Project-membership status of a reference target relative to the active
 * Project: the target lives in the same file, in a file included in the
 * active Project, in an in-root file omitted from the active Project, in
 * another Project root, or in a standalone document outside any Project.
 * Status affects export warnings and insertion affordances, never whether
 * the editor can find or navigate to the target.
 */
export type ProjectReferenceStatus =
  | 'same-file'
  | 'in-active-project'
  | 'omitted-from-active-project'
  | 'another-project'
  | 'standalone'

/**
 * One Project root visible to the reference layer (issue #1 Phase 7). This
 * is the pure projection of a DirDescriptor whose settings.project is
 * non-null: `rootPath` is the absolute directory path and `files` is the
 * ordered, project-relative (Unix-separator) ProjectSettings.files list.
 * Status computation takes these specs explicitly so it stays pure and
 * headless-testable — it never reads .ztr-directory files itself.
 */
export interface ProjectRootSpec {
  /** The absolute path of the Project's root directory */
  rootPath: string
  /** The ordered project-relative export file list (ProjectSettings.files) */
  files: string[]
}

/**
 * The mechanical "append and continue" plan for inserting a reference to an
 * in-root file omitted from the active Project (issue #1 Phase 7).
 *
 * - `rootPath` is the active Project root whose ProjectSettings.files gains
 *   the appended entries (applied through the existing dir-settings surface:
 *   the 'update-project-properties' command -> FSAL.updateProject()).
 * - `appendFiles` lists the ordered project-relative paths to append: when
 *   the SOURCE document is itself omitted from the active Project it comes
 *   first, then the target — both are appended in one operation and BOTH are
 *   named in one confirmation toast.
 */
export interface AppendAndContinuePlan {
  /** The absolute root path of the active Project being amended */
  rootPath: string
  /** Ordered project-relative paths to append to ProjectSettings.files */
  appendFiles: string[]
}

/**
 * One typed label entry of the renderer's 'references' completion database,
 * pushed into the editor through setCompletionDatabase('references', …) and
 * consumed by the combined `@` completion surface.
 *
 * Phase 3 contract (issue #1): `projectStatus` is optional and defaults to
 * undefined; completion renders label entries without any status gating.
 *
 * Phase 7 contract (issue #1): the provider side computes `projectStatus`
 * for every entry (annotateCompletionEntries in
 * common/pandoc-util/project-reference-status.ts) and attaches `appendPlan`
 * exactly on omitted-from-active-Project entries. Entries stay visible with
 * unchanged label/detail text regardless of status; the status feeds the
 * insertion affordance only (disabled / append-and-continue / export-unit
 * warning).
 */
export interface ReferenceCompletionEntry {
  /** The full authored key, e.g. 'thm:main' (colons inside keys preserved) */
  key: string
  family: ReferenceFamily
  /** The authored title/caption, or undefined when nothing was authored */
  title: string | undefined
  documentPath: string
  /** Optional Project-membership status; undefined until Phase 7 computes it */
  projectStatus?: ProjectReferenceStatus
  /** The append-and-continue plan, present exactly on omitted entries */
  appendPlan?: AppendAndContinuePlan
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

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace reference state field
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single typed state source for every Phase 4 reference
 *                  presentation surface (issue #1): reference chips,
 *                  definition badges, hover previews, and reference
 *                  diagnostics all read this field and nothing else.
 *
 *                  STATE-SOURCE DECISION (issue #1 Phase 4): the Phase-3
 *                  referencesUpdateField (autocomplete/at-symbols.ts) is the
 *                  locked completion contract and stays untouched; its
 *                  ReferenceCompletionEntry[] payload deliberately carries no
 *                  ranges or resolutions. Phase 4 needs the resolved
 *                  workspace view as typed in the model, so it gets its own
 *                  sibling effect/field pair carrying:
 *
 *                  - `snapshot`: the CURRENT document's live
 *                    DocumentReferenceSnapshot (definitions and occurrences
 *                    with exact live ranges),
 *                  - `workspaceOccurrences`: every occurrence across the
 *                    merged workspace view (the citing-location index behind
 *                    the `N references` badges), and
 *                  - `resolutions`: the workspace resolution map produced by
 *                    resolveWorkspace() over the merged snapshot view.
 *
 *                  MainEditor.vue feeds this field from the same
 *                  'reference-provider' get-snapshot fetch that already feeds
 *                  the completion database; citations.ts and the citation
 *                  renderer remain untouched.
 *
 * END HEADER
 */

import { StateEffect, StateField } from '@codemirror/state'
import { referenceDisplayNumbers } from '@common/pandoc-util/reference-numbering'
import type { Citation } from '../parser/citation-parser'
import type {
  DocumentReferenceSnapshot,
  ProjectRootSpec,
  ReferenceOccurrence,
  Resolution
} from '@dts/common/references'

/**
 * The complete typed reference view one editor needs to present references:
 * the current document's live snapshot, the workspace-wide occurrence index,
 * and the workspace resolution map.
 */
export interface EditorWorkspaceReferences {
  /** The current document's live reference snapshot (exact live ranges) */
  snapshot: DocumentReferenceSnapshot
  /** Every occurrence across the merged workspace view (citing index) */
  workspaceOccurrences: ReferenceOccurrence[]
  /** The workspace resolution map over the merged snapshot view */
  resolutions: Map<string, Resolution>
  /**
   * Every visible Project root (issue #1 Phase 7). The hover tooltip derives
   * the displayed Project status from these roots plus the snapshot's own
   * documentPath (the active document). While undefined, presentation
   * surfaces show NO Project status — they never fabricate one.
   */
  projectRoots?: ProjectRootSpec[]
}

/**
 * Use this effect to provide the editor state with a new resolved workspace
 * reference view.
 */
export const workspaceReferencesUpdate = StateEffect.define<EditorWorkspaceReferences>()

/** What Pandoc read in one citation: the part that does not depend on where the citation is. */
export type CitationReading = Pick<Citation, 'composite'|'items'>

/**
 * The values that the reference renderers draw. Each part keeps its object
 * between two workspace reference views that give it the same content, so a
 * renderer renders again only when the part it reads is a new object.
 */
export interface ReferencePresentation {
  /** The editor-local display number of each uniquely resolved key. */
  displayNumbers: ReadonlyMap<string, string>
  /**
   * Pandoc's reading of each citation of the document, by the authored text
   * of the citation. Pandoc reads each citation alone, so the reading follows
   * from that text. A text with no entry is not a citation to Pandoc. Null
   * until the first extraction arrives.
   */
  citations: ReadonlyMap<string, CitationReading>|null
  citationError: string|undefined
}

function sameEntries<Value> (
  a: ReadonlyMap<string, Value>,
  b: ReadonlyMap<string, Value>,
  sameValue: (x: Value, y: Value) => boolean
): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [ key, value ] of a) {
    const other = b.get(key)
    if (other === undefined || !sameValue(value, other)) {
      return false
    }
  }
  return true
}

function sameReading (a: CitationReading, b: CitationReading): boolean {
  return a.composite === b.composite && JSON.stringify(a.items) === JSON.stringify(b.items)
}

function nextPresentation (previous: ReferencePresentation, references: EditorWorkspaceReferences): ReferencePresentation {
  let displayNumbers: ReadonlyMap<string, string> = referenceDisplayNumbers(references.resolutions, references.projectRoots)
  if (sameEntries(displayNumbers, previous.displayNumbers, (x, y) => x === y)) {
    displayNumbers = previous.displayNumbers
  }

  // The snapshot has neither citations nor an error while Pandoc reads the
  // document. The last reading stays: it is correct for each citation whose
  // text did not change.
  const { citations: extracted, citationError: extractionError } = references.snapshot
  let citations = previous.citations
  let citationError = previous.citationError
  if (extracted !== undefined) {
    const readings = new Map<string, CitationReading>(extracted.map(citation => [ citation.source, citation ]))
    if (citations === null || !sameEntries(readings, citations, sameReading)) {
      citations = readings
    }
    citationError = undefined
  } else if (extractionError !== undefined) {
    citationError = extractionError
  }

  if (
    displayNumbers === previous.displayNumbers &&
    citations === previous.citations &&
    citationError === previous.citationError
  ) {
    return previous
  }
  return { displayNumbers, citations, citationError }
}

/** The presentation derived from the newest workspace reference view. */
export const referencePresentationField = StateField.define<ReferencePresentation>({
  create (_state) {
    return { displayNumbers: new Map(), citations: null, citationError: undefined }
  },
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(workspaceReferencesUpdate)) {
        return nextPresentation(value, effect.value)
      }
    }
    return value
  }
})

/**
 * Holds the resolved workspace reference view, or null until the first
 * update arrives. Consumers must present nothing (and never fabricate
 * resolutions) while the field is null.
 */
export const workspaceReferencesField = StateField.define<EditorWorkspaceReferences|null>({
  create (_state) {
    return null
  },
  update (val, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(workspaceReferencesUpdate)) {
        return effect.value
      }
    }
    return val
  },
  provide: () => referencePresentationField
})

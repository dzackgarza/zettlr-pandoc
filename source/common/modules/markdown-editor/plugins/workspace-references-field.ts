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

import { StateEffect, StateField } from "@codemirror/state";
import type {
  DocumentReferenceSnapshot,
  ProjectRootSpec,
  ReferenceOccurrence,
  Resolution,
} from "@dts/common/references";

/**
 * The complete typed reference view one editor needs to present references:
 * the current document's live snapshot, the workspace-wide occurrence index,
 * and the workspace resolution map.
 */
export interface EditorWorkspaceReferences {
  /** The current document's live reference snapshot (exact live ranges) */
  snapshot: DocumentReferenceSnapshot;
  /** Every occurrence across the merged workspace view (citing index) */
  workspaceOccurrences: ReferenceOccurrence[];
  /** The workspace resolution map over the merged snapshot view */
  resolutions: Map<string, Resolution>;
  /**
   * Every visible Project root (issue #1 Phase 7). The hover tooltip derives
   * the displayed Project status from these roots plus the snapshot's own
   * documentPath (the active document). While undefined, presentation
   * surfaces show NO Project status — they never fabricate one.
   */
  projectRoots?: ProjectRootSpec[];
}

/**
 * Use this effect to provide the editor state with a new resolved workspace
 * reference view.
 */
export const workspaceReferencesUpdate = StateEffect.define<EditorWorkspaceReferences>();

/**
 * Holds the resolved workspace reference view, or null until the first
 * update arrives. Consumers must present nothing (and never fabricate
 * resolutions) while the field is null.
 */
export const workspaceReferencesField = StateField.define<EditorWorkspaceReferences | null>({
  create(_state) {
    return null;
  },
  update(val, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(workspaceReferencesUpdate)) {
        return effect.value;
      }
    }
    return val;
  },
});

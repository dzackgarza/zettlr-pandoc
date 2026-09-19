/** CodeMirror adapter for renderer-neutral workspace reference diagnostics. */

import { type Diagnostic, linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { referenceLintText } from "@common/util/reference-lint-core";
import { availableCitationKeys } from "../autocomplete/citations";
import { workspaceReferencesField } from "../plugins/workspace-references-field";

export async function referenceLintSource(view: EditorView): Promise<Diagnostic[]> {
  const references = view.state.field(workspaceReferencesField, false) ?? null;
  if (references === null) {
    return [];
  }
  return referenceLintText(view.state.doc.toString(), {
    snapshot: references.snapshot,
    resolutions: references.resolutions,
    citationKeys: availableCitationKeys(view.state),
  });
}

export const referenceLint = linter(referenceLintSource);

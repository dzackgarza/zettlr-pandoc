/** CodeMirror adapter for the shared LaTeX-environment block lint. */

import { type Diagnostic, linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { latexEnvironmentLintText } from "@common/util/latex-environment-lint-core";

export function latexEnvironmentLintSource(view: EditorView): Diagnostic[] {
  return latexEnvironmentLintText(view.state.doc.toString());
}

export const latexEnvironmentLint = linter(latexEnvironmentLintSource);

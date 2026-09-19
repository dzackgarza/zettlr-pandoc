/** Renderer adapter for the shared scholarly document lint core. */

import { type Diagnostic, linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { scholarlyLintText } from "@common/util/scholarly-lint-core";
import { configuredMathMacros, knownTexControlWords } from "../autocomplete/tex-commands";
import { workspaceReferencesField } from "../plugins/workspace-references-field";
import { configField } from "../util/configuration";

export async function scholarlyLintSource(view: EditorView): Promise<Diagnostic[]> {
  const markdown = view.state.doc.toString();
  const referenceContext = view.state.field(workspaceReferencesField, false);
  const sourcePath = view.state.field(configField, false)?.metadata.path ?? "";
  const referenceAuthorityReady =
    referenceContext === undefined ||
    (referenceContext !== null && referenceContext.projectRoots !== undefined);
  const [knownCommands, configuredMacros] = await Promise.all([
    knownTexControlWords(),
    configuredMathMacros(),
  ]);

  return await scholarlyLintText(markdown, {
    knownCommands,
    configuredMacros,
    sourcePath,
    projectRoots: referenceContext?.projectRoots?.map((root) => root.rootPath) ?? [],
    resolveResources:
      sourcePath === "" || !referenceAuthorityReady
        ? undefined
        : async (request) => await window.ipc.invoke("tex-resource-probe", request),
  });
}

export const scholarlyLint = linter(scholarlyLintSource);

import { type Diagnostic, linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { tikzCompileLintText } from "@common/util/tikz-compile-lint-core";
import { requestTikzRender } from "../tikz-render-client";
import { configField } from "../util/configuration";

export async function tikzCompileLintSource(view: EditorView): Promise<Diagnostic[]> {
  return await tikzCompileLintText(
    view.state.doc.toString(),
    view.state.field(configField, false)?.metadata.path ?? "",
    requestTikzRender,
  );
}

export const tikzCompileLint = linter(tikzCompileLintSource, { delay: 350 });

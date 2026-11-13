/**
 * The only CodeMirror lint bridge.
 *
 * External linters return editor-neutral source diagnostics. This adapter maps
 * those diagnostics and their generic actions onto CodeMirror's presentation
 * surface. No lint rule semantics belong here.
 *
 * A provider that rejects gave no result. CodeMirror writes the rejection
 * of a lint source to the console and keeps the diagnostics of the run
 * before, so the adapter turns a rejection into one error diagnostic that
 * carries the cause.
 */

import { type Action, type Diagnostic, linter } from "@codemirror/lint";
import { type Extension, StateEffect } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type {
  ExternalDiagnostic,
  ExternalDiagnosticAction,
  ExternalLinter,
  ExternalLintResult,
} from "@common/diagnostics/external-linter";
import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";

/**
 * A transaction with this effect makes each external linter run again on
 * the same text. The author asks for it after a lint that did not run.
 */
export const externalLintAgain = StateEffect.define<null>();

function asksForLint(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(externalLintAgain)),
  );
}

export type ExternalLinterPresentationConfig = NonNullable<Parameters<typeof linter>[1]>;

export interface ExternalLinterAdapter<Context, Metadata = undefined> {
  provider: ExternalLinter<Context, Metadata>;
  context: (view: EditorView) => Context;
  config?: ExternalLinterPresentationConfig;
  onStart?: (view: EditorView) => void;
  onResult?: (view: EditorView, result: ExternalLintResult<Metadata>) => void;
  /** The provider rejected: the run gave no result. */
  onFailure?: (view: EditorView, cause: string) => void;
  onCommand?: (
    view: EditorView,
    action: Extract<ExternalDiagnosticAction, { kind: "command" }>,
  ) => void;
}

export interface ExternalLinterPlugin<Context, Metadata = undefined>
  extends ExternalLinterAdapter<Context, Metadata> {
  extensions?: readonly Extension[];
}

function actionToCodeMirror<Context, Metadata>(
  action: ExternalDiagnosticAction,
  adapter: ExternalLinterAdapter<Context, Metadata>,
): Action {
  if (action.kind === "replace") {
    return {
      name: action.name,
      markClass: action.markClass,
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: action.replacement } });
      },
    };
  }

  return {
    name: action.name,
    markClass: action.markClass,
    apply(view) {
      adapter.onCommand?.(view, action);
    },
  };
}

export function externalDiagnosticToCodeMirror<Context, Metadata>(
  diagnostic: ExternalDiagnostic,
  adapter: ExternalLinterAdapter<Context, Metadata>,
): Diagnostic {
  return {
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    markClass: diagnostic.markClass,
    actions: diagnostic.actions?.map((action) => actionToCodeMirror(action, adapter)),
  };
}

export function externalLinterExtension<Context, Metadata = undefined>(
  adapter: ExternalLinterAdapter<Context, Metadata>,
): Extension {
  const needsRefresh = adapter.config?.needsRefresh;
  return linter(
    async (view) => {
      adapter.onStart?.(view);
      const run = async (): Promise<ExternalLintResult<Metadata>> =>
        await adapter.provider.run({
          text: view.state.doc.toString(),
          context: adapter.context(view),
        });
      return await run().then(
        (result) => {
          adapter.onResult?.(view, result);
          return result.diagnostics.map((diagnostic) =>
            externalDiagnosticToCodeMirror(diagnostic, adapter),
          );
        },
        (failure: Error) => {
          reportError(`The check ${adapter.provider.id} did not run`, failure);
          adapter.onFailure?.(view, failure.message);
          return [checkDidNotRun(view, adapter.provider.id, failure.message)];
        },
      );
    },
    {
      ...adapter.config,
      needsRefresh: (update) => asksForLint(update) || needsRefresh?.(update) === true,
    },
  );
}

/** The diagnostic of a run that gave no result, at the start of the document. */
function checkDidNotRun(view: EditorView, providerId: string, cause: string): Diagnostic {
  return {
    from: 0,
    to: Math.min(1, view.state.doc.length),
    severity: "error",
    message: trans("This check did not run: %s", cause),
    source: providerId,
  };
}

export function externalLinterPluginExtensions<Context, Metadata = undefined>(
  plugin: ExternalLinterPlugin<Context, Metadata>,
): Extension[] {
  const lint = externalLinterExtension(plugin);
  // A plugin without presentation extensions contributes only its linter.
  if (plugin.extensions === undefined) {
    return [lint];
  }
  return [...plugin.extensions, lint];
}

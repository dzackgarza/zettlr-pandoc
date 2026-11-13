/**
 * Generic external-linter to CodeMirror diagnostic mapping, and the editor
 * of a linter that rejects: a real `EditorView` with the real lint extension.
 */

import { type Diagnostic, forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import {
  type ExternalLinterAdapter,
  externalDiagnosticToCodeMirror,
  externalLintAgain,
  externalLinterExtension,
} from "source/common/modules/markdown-editor/diagnostics/external-linter-adapter";

const adapter: ExternalLinterAdapter<undefined> = {
  provider: {
    id: "test",
    run: () => ({ diagnostics: [] }),
  },
  context: () => undefined,
};

describe("external linter adapter diagnostic mapping", function () {
  it("preserves source offsets and source labels exactly", function () {
    const diagnostic = externalDiagnosticToCodeMirror(
      {
        from: 7,
        to: 12,
        severity: "warning",
        message: "heading level jump",
        source: "Markdown (heading/increment)",
      },
      adapter,
    );

    assert.equal(diagnostic.from, 7);
    assert.equal(diagnostic.to, 12);
    assert.equal(diagnostic.source, "Markdown (heading/increment)");
  });

  it("maps generic replacement actions without provider-specific editor logic", function () {
    const diagnostic = externalDiagnosticToCodeMirror(
      {
        from: 0,
        to: 3,
        severity: "error",
        message: "replace this",
        actions: [
          {
            kind: "replace",
            name: "fixed",
            replacement: "fixed",
          },
        ],
      },
      adapter,
    );

    assert.equal(diagnostic.actions?.length, 1);
    assert.equal(diagnostic.actions?.[0].name, "fixed");
  });
});

describe("an external linter that rejects", function () {
  const CAUSE = "the results of the lint cannot be written";
  const TEXT = "Residue ???\n";
  let view: EditorView;

  afterEach(function () {
    view.destroy();
  });

  function diagnosticsOf(state: EditorState): Diagnostic[] {
    const found: Diagnostic[] = [];
    forEachDiagnostic(state, (diagnostic) => found.push(diagnostic));
    return found;
  }

  /** Runs the pending lint of the view and gives the diagnostics it set. */
  async function lint(): Promise<Diagnostic[]> {
    const before = view.state;
    forceLinting(view);
    const deadline = Date.now() + 5_000;
    while (view.state === before) {
      assert.ok(Date.now() < deadline, "the lint set no diagnostics");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return diagnosticsOf(view.state);
  }

  it("marks the document with one error that carries the cause", async function () {
    const reported: string[] = [];
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: TEXT,
        extensions: externalLinterExtension({
          provider: { id: "refusing", run: async () => await Promise.reject(new Error(CAUSE)) },
          context: () => undefined,
          onFailure: (_view, cause) => reported.push(cause),
        }),
      }),
    });

    const diagnostics = await lint();
    assert.equal(diagnostics.length, 1, "one diagnostic stands for the run");
    assert.equal(diagnostics[0].severity, "error");
    assert.equal(diagnostics[0].source, "refusing", "the diagnostic names the check");
    assert.deepEqual([diagnostics[0].from, diagnostics[0].to], [0, 1]);
    assert.ok(diagnostics[0].message.includes(CAUSE), "the author reads the cause");
    assert.deepEqual(reported, [CAUSE], "the plugin of the check gets the cause");
  });

  it("marks an empty document", async function () {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "",
        extensions: externalLinterExtension({
          provider: { id: "refusing", run: async () => await Promise.reject(new Error(CAUSE)) },
          context: () => undefined,
        }),
      }),
    });

    const diagnostics = await lint();
    assert.deepEqual(
      diagnostics.map((diagnostic) => [diagnostic.from, diagnostic.to, diagnostic.severity]),
      [[0, 0, "error"]],
    );
  });

  it("runs the check again on the same text when the author asks", async function () {
    const texts: string[] = [];
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: TEXT,
        extensions: externalLinterExtension({
          provider: {
            id: "recovering",
            // The first run is refused; each later run finds the residue.
            run: async ({ text }) => {
              texts.push(text);
              if (texts.length === 1) {
                return await Promise.reject(new Error(CAUSE));
              }
              return {
                diagnostics: [{ from: 8, to: 11, severity: "warning", message: "residue" }],
              };
            },
          },
          context: () => undefined,
        }),
      }),
    });

    const refused = await lint();
    assert.equal(refused[0].severity, "error");

    view.dispatch({ effects: externalLintAgain.of(null) });
    const linted = await lint();
    assert.deepEqual(texts, [TEXT, TEXT], "the second run reads the same text");
    assert.deepEqual(
      linted.map((diagnostic) => [diagnostic.from, diagnostic.to, diagnostic.severity]),
      [[8, 11, "warning"]],
      "the result of the second run replaces the error",
    );
  });
});

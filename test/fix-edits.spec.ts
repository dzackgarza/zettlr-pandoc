// This side-effect import must run before any main-process module import. It
// installs the headless Electron module shim that those imports consume.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { fixEdits } from "source/app/service-providers/document-lint";
import type { DocumentLintDiagnostic } from "source/app/util/document-lint";

function diagnostic(from: number, to: number, replacement?: string): DocumentLintDiagnostic {
  return {
    from,
    to,
    severity: "warning",
    message: "",
    source: "Flowmark",
    rule: "math/bare-operator",
    line: 1,
    column: from + 1,
    endLine: 1,
    endColumn: to + 1,
    ...(replacement === undefined ? {} : { fix: { title: "", replacement } }),
  };
}

describe("Fix All edits of one pass", function () {
  it("takes every fix in source order and leaves suggestions without a fix", function () {
    const edits = fixEdits([diagnostic(10, 13, "\\cos"), diagnostic(20, 24), diagnostic(1, 4, "\\sin")]);
    assert.deepEqual(
      edits.map((edit) => [edit.from, edit.to, edit.insert]),
      [
        [1, 4, "\\sin"],
        [10, 13, "\\cos"],
      ],
    );
  });

  it("skips a fix that overlaps one already taken", function () {
    const edits = fixEdits([diagnostic(0, 8, "whole"), diagnostic(4, 6, "inner"), diagnostic(8, 9, "next")]);
    assert.deepEqual(
      edits.map((edit) => edit.insert),
      ["whole", "next"],
    );
  });
});

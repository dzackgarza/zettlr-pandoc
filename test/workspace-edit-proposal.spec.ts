/**
 * A workspace edit proposal (#6): the edits take each document from its text
 * to the text after the edit, the preview shows each changed run of lines
 * before and after, and the documents are in the order of a file tree.
 */

import { ChangeSet, Text } from "@codemirror/state";
import { hashDocumentSource } from "@common/pandoc-util/extract-references";
import { lineChanges } from "@common/util/workspace-edit-preview";
import type { WorkspaceTextEdit } from "@dts/common/references";
import { deepStrictEqual, ok, strictEqual } from "assert";
import { proposalOf } from "source/app/util/workspace-edit-proposal";

/** The text after the edits of one document, applied as the transaction applies them. */
function applied(
  source: string,
  edits: Array<{ range: { from: number; to: number }; insert: string }>,
): string {
  const changes = ChangeSet.of(
    edits.map(({ range, insert }) => ({ from: range.from, to: range.to, insert })),
    source.length,
  );
  return changes.apply(Text.of(source.split("\n"))).toString();
}

describe("The changed lines of a workspace edit", function () {
  it("gives each changed run of lines with its first line in the text before", function () {
    const source = "# Title\n\nOne [[a]].\nTwo.\n\nThree [[a]] and [[a]].\n";
    const target = "# Title\n\nOne [[b]].\nTwo.\n\nThree [[b]] and [[b]].\n";
    deepStrictEqual(lineChanges(source, target), [
      { line: 3, before: "One [[a]].", after: "One [[b]]." },
      { line: 6, before: "Three [[a]] and [[a]].", after: "Three [[b]] and [[b]]." },
    ]);
  });

  it("gives a run of several lines as one change, and an added line with an empty before", function () {
    const source = "---\nkeywords: [x]\n---\nText #x.\n";
    const target = "---\nkeywords:\n  - y\n---\nText.\n";
    deepStrictEqual(lineChanges(source, target), [
      { line: 2, before: "keywords: [x]", after: "keywords:\n  - y" },
      { line: 4, before: "Text #x.", after: "Text." },
    ]);
    deepStrictEqual(lineChanges("a\n", "a\nb\n"), [{ line: 2, before: "", after: "b" }]);
  });
});

describe("A workspace edit proposal", function () {
  const documents = [
    { documentPath: "/ws/notes/sub/deep.md", source: "x [[a]]\n", target: "x [[b]]\n" },
    { documentPath: "/ws/notes/same.md", source: "unchanged\n", target: "unchanged\n" },
    { documentPath: "/ws/zeta.md", source: "z [[a]]\nend\n", target: "z [[b]]\nend\n" },
    { documentPath: "/ws/notes/alpha.md", source: "[[a]] [[a]]\n", target: "[[b]] [[b]]\n" },
  ];

  it("holds the edits that make each changed document its target, fenced by the hash of its text", function () {
    const proposal = proposalOf("Update links", "a moved to b.", documents);
    ok(proposal !== undefined);
    for (const { documentPath, source, target } of documents.filter((d) => d.source !== d.target)) {
      const edits: WorkspaceTextEdit[] = proposal.edits.filter(
        (edit) => edit.documentPath === documentPath,
      );
      strictEqual(applied(source, edits), target);
      strictEqual(proposal.expectedSourceHashes[documentPath], hashDocumentSource(source));
    }
    strictEqual(proposal.expectedSourceHashes["/ws/notes/same.md"], undefined);
    ok(proposal.edits.every((edit) => edit.documentPath !== "/ws/notes/same.md"));
  });

  it("previews the documents in the order of a file tree: the files of a folder before its subfolders", function () {
    const proposal = proposalOf("Update links", "a moved to b.", documents);
    deepStrictEqual(
      proposal?.documents.map(({ documentPath }) => documentPath),
      ["/ws/zeta.md", "/ws/notes/alpha.md", "/ws/notes/sub/deep.md"],
    );
    deepStrictEqual(proposal?.documents[1].changes, [
      { line: 1, before: "[[a]] [[a]]", after: "[[b]] [[b]]" },
    ]);
  });

  it("is no proposal when no document changes", function () {
    strictEqual(proposalOf("Update links", "a moved to b.", [documents[1]]), undefined);
  });
});

/**
 * Review sessions may arrive while MarkdownEditor is still fetching its
 * authority document. They must become active as part of readiness itself,
 * not wait for an unrelated later document edit.
 */

import "./provision-renderer-window-seams";
import { DocumentType } from "@dts/common/documents";
import type { ReviewDiffSession } from "@dts/common/review-diff";
import { strict as assert } from "assert";
import MarkdownEditor, { type DocumentAuthorityAPI } from "source/common/modules/markdown-editor";

describe("MarkdownEditor review activation at readiness", function () {
  it("activates a review received before the authority fetch resolves", async function () {
    const path = "/tmp/review-ready.md";
    const workingText = "prefix PROPOSED suffix\n";
    let resolveFetch!: (value: {
      content: string;
      type: DocumentType;
      startVersion: number;
    }) => void;
    const fetch = new Promise<{ content: string; type: DocumentType; startVersion: number }>(
      (resolve) => {
        resolveFetch = resolve;
      },
    );
    const never = new Promise<never>(() => {});
    const authority: DocumentAuthorityAPI = {
      fetchDoc: async () => await fetch,
      pullUpdates: async () => await never,
      pushUpdates: async () => true,
    };
    const editor = new MarkdownEditor("leaf", "window", path, authority);
    const start = workingText.indexOf("PROPOSED");
    const review: ReviewDiffSession = {
      id: "review-ready",
      reviewGeneration: 1,
      documentPath: path,
      workingText,
      frozenText: undefined,
      suggestions: [
        {
          suggestionId: "suggestion-ready",
          removedText: "baseline",
          anchors: [{ from: start, to: start + "PROPOSED".length }],
          seam: start,
          description: "Replace baseline wording.",
        },
      ],
      chunkComments: [],
    };

    editor.startReviewDiffSession(review);
    assert.equal(editor.instance.dom.classList.contains("review-diff-active"), false);

    resolveFetch({ content: workingText, type: DocumentType.Markdown, startVersion: 0 });
    await editor.ready;

    assert.equal(editor.instance.state.doc.toString(), workingText);
    assert.equal(editor.instance.dom.classList.contains("review-diff-active"), true);
    assert.equal(editor.instance.dom.querySelectorAll(".cm-changedText").length, 1);
    assert.equal(editor.instance.dom.querySelectorAll(".cm-deletedText").length, 1);

    editor.startReviewDiffSession({
      ...review,
      reviewGeneration: 2,
      frozenText: "the text the review was made in\n",
    });
    assert.equal(editor.instance.dom.classList.contains("review-diff-active"), false);
    assert.equal(editor.instance.dom.querySelectorAll(".cm-changedText").length, 0);
    editor.unmount();
  });
});

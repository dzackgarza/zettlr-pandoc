import "./provision-renderer-window-seams";
import { ensureSyntaxTree } from "@codemirror/language";
import { type ChangeSpec, EditorState, type Extension } from "@codemirror/state";
import { type Decoration, EditorView, WidgetType } from "@codemirror/view";
import { DocumentType } from "@dts/common/documents";
import type { ReviewDiffSession, ReviewSuggestionView } from "@dts/common/review-diff";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { renderBlockWidgets } from "@dzack/pandoc-editor/renderers/base-renderer";
import { rangeInPreviewSuppression } from "@dzack/pandoc-editor/util/range-in-preview-suppression";
import { strict as assert } from "assert";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import MarkdownEditor, { type DocumentAuthorityAPI } from "source/common/modules/markdown-editor";
import { collaborationControls } from "source/common/modules/markdown-editor/plugins/collaboration-controls";
import {
  getReviewChunks,
  reviewChunksExtension,
  reviewSuggestionsInRange,
} from "source/common/modules/markdown-editor/plugins/review-chunks";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";
import { mapSuggestionThroughChanges } from "source/common/util/review-suggestion-anchors";

class MathMarker extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: MathMarker): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    return document.createElement("span");
  }
}

const PARAGRAPHS = 2000;

function paragraphs(count: number): string {
  let doc = "";
  for (let i = 0; i < count; i++) {
    doc += `Paragraph ${i} holds $x_{${i}}$ and $y_{${i}}$ in a sentence.\n\n`;
  }
  return doc;
}

function suggestionsOf(doc: string, every: number): ReviewSuggestionView[] {
  const suggestions: ReviewSuggestionView[] = [];
  let from = doc.indexOf("holds");
  for (let i = 0; from !== -1; i++) {
    if (i % every === 0) {
      suggestions.push({
        suggestionId: `suggestion-${i}`,
        removedText: "has",
        anchors: [{ from, to: from + "holds".length }],
        seam: from,
        description: `Paragraph ${i} states the claim.`,
      });
    }
    from = doc.indexOf("holds", from + 1);
  }
  return suggestions;
}

function farFromEachChunk(doc: string): number {
  const paragraph = doc.indexOf(`Paragraph ${PARAGRAPHS / 2 + 1} `);
  return doc.indexOf("in a sentence", paragraph);
}

function parsed(state: EditorState): EditorState {
  assert.notEqual(ensureSyntaxTree(state, state.doc.length, 60_000), null);
  return state.update({}).state;
}

function decorationValues(state: EditorState): Set<Decoration> {
  const values = new Set<Decoration>();
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") {
      continue;
    }
    const cursor = source.iter();
    while (cursor.value !== null) {
      values.add(cursor.value);
      cursor.next();
    }
  }
  return values;
}

function newDecorations(before: EditorState, after: EditorState): number {
  const old = decorationValues(before);
  return [...decorationValues(after)].filter((value) => !old.has(value)).length;
}

const noHost = (_dom: HTMLElement): (() => void) => {
  return () => {};
};

describe("A review with many chunks", function () {
  this.timeout(120_000);

  before(async function () {
    await initializeMathJax(await loadMathJaxMacros("test/fixtures/mathjax-macros.json"));
  });

  interface TypedCharacterCost {
    widgets: number;
    decorations: number;
  }

  function typedCharacterCost(every: number): TypedCharacterCost {
    const doc = paragraphs(PARAGRAPHS);
    let made = 0;
    const counted = renderBlockWidgets(
      ["InlineCode"],
      () => true,
      (state, node) => {
        made += 1;
        return new MathMarker(state.sliceDoc(node.from, node.to));
      },
    );
    const state = parsed(
      EditorState.create({
        doc,
        extensions: [
          markdownParser(),
          configField,
          counted,
          reviewChunksExtension({ suggestions: suggestionsOf(doc, every) }),
          collaborationControls(noHost),
        ],
      }),
    );
    const position = farFromEachChunk(doc);
    made = 0;
    const typed = state.update({
      changes: { from: position, insert: "x" },
      selection: { anchor: position + 1 },
    }).state;
    return { widgets: made, decorations: newDecorations(state, typed) };
  }

  it("costs the same for a typed character far from each chunk with two and with a thousand chunks", function () {
    const few = typedCharacterCost(PARAGRAPHS / 2);
    const many = typedCharacterCost(2);
    assert.deepEqual(many, few);
  });

  async function broadcastCost(every: number): Promise<number> {
    const path = "/tmp/review-chunk-cost.md";
    const doc = paragraphs(PARAGRAPHS);
    const never = new Promise<never>(() => {});
    const authority: DocumentAuthorityAPI = {
      fetchDoc: async () => ({ content: doc, type: DocumentType.Markdown, startVersion: 0 }),
      pullUpdates: async () => await never,
      pushUpdates: async () => true,
    };
    const editor = new MarkdownEditor("leaf", "window", path, authority);
    await editor.ready;
    editor.setCollaborationControls(noHost);
    const suggestions = suggestionsOf(doc, every);
    const review: ReviewDiffSession = {
      id: "review-of-many-chunks",
      reviewGeneration: 1,
      documentPath: path,
      workingText: doc,
      frozenText: undefined,
      suggestions,
      chunkComments: [],
    };
    editor.startReviewDiffSession(review);
    const before = editor.instance.state;

    const position = farFromEachChunk(doc);
    editor.instance.dispatch({ changes: { from: position, insert: "x" } });
    const changes = editor.instance.state.changes({ from: position, insert: "x" });
    editor.startReviewDiffSession({
      ...review,
      reviewGeneration: 2,
      workingText: editor.instance.state.doc.toString(),
      suggestions: suggestions.map((suggestion) => {
        const mapped = mapSuggestionThroughChanges(suggestion, changes);
        return { ...suggestion, anchors: mapped.anchors, seam: mapped.seam };
      }),
    });
    const cost = newDecorations(before, editor.instance.state);
    editor.unmount();
    return cost;
  }

  it("makes the same new decorations for a typed character and its broadcast with two and with a thousand chunks", async function () {
    const few = await broadcastCost(PARAGRAPHS / 2);
    const many = await broadcastCost(2);
    assert.equal(many, few);
  });
});

describe("A review after a sequence of edits", function () {
  const WORKING = [
    "# Review",
    "",
    "alpha proposed text",
    "",
    "bravo proposed first half",
    "bravo proposed second half",
    "",
    "charlie keeps its words",
    "",
    "delta end",
  ].join("\n");

  function at(text: string, occurrence = 0): number {
    let from = -1;
    for (let i = 0; i <= occurrence; i++) {
      from = WORKING.indexOf(text, from + 1);
    }
    assert.notEqual(from, -1, `fixture text not found: ${text}`);
    return from;
  }

  function suggestions(): ReviewSuggestionView[] {
    const alpha = at("proposed");
    const bravo = at("proposed", 1);
    const charlie = at("keeps");
    const delta = at("end");
    return [
      {
        suggestionId: "alpha",
        removedText: "old",
        anchors: [{ from: alpha, to: alpha + "proposed".length }],
        seam: alpha,
        description: "alpha",
      },
      {
        suggestionId: "bravo",
        removedText: "",
        anchors: [{ from: bravo, to: at("second half") + "second half".length }],
        seam: bravo,
        description: "bravo",
      },
      {
        suggestionId: "charlie",
        removedText: "removed words ",
        anchors: [],
        seam: charlie,
        description: "charlie",
      },
      {
        suggestionId: "delta",
        removedText: "",
        anchors: [{ from: delta, to: delta + "end".length }],
        seam: delta,
        description: "delta",
      },
    ];
  }

  function extensions(review: ReviewSuggestionView[]): Extension[] {
    return [reviewChunksExtension({ suggestions: review }), collaborationControls(noHost)];
  }

  function shown(state: EditorState): unknown {
    const marks: string[] = [];
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === "function") {
        continue;
      }
      const cursor = source.iter();
      while (cursor.value !== null) {
        const spec = cursor.value.spec;
        const kind = spec.widget !== undefined ? spec.widget.constructor.name : String(spec.class);
        marks.push(`${cursor.from}-${cursor.to}:${kind}`);
        cursor.next();
      }
    }
    const lines: boolean[] = [];
    const touching: string[][] = [];
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number);
      lines.push(rangeInPreviewSuppression(state, line.from, line.to));
      touching.push(
        reviewSuggestionsInRange(state, line.from, line.to).map(
          (suggestion) => suggestion.suggestionId,
        ),
      );
    }
    return { chunks: getReviewChunks(state), marks: marks.sort(), lines, touching };
  }

  it("shows what a new editor shows for the suggestions that the provider maps", function () {
    const edits: Array<(doc: string) => ChangeSpec> = [
      (doc) => ({ from: doc.indexOf("Review"), insert: "A " }),
      (doc) => ({ from: doc.indexOf("proposed") + 4, insert: "OWNER" }),
      (doc) => ({ from: doc.indexOf("bravo"), insert: "\n" }),
      (doc) => ({
        from: doc.indexOf("end"),
        to: doc.indexOf("end") + "end".length,
        insert: "stop",
      }),
      (doc) => ({ from: doc.indexOf("text"), to: doc.indexOf("first") }),
      (doc) => ({ from: doc.indexOf("keeps"), insert: "now " }),
    ];
    let state = EditorState.create({ doc: WORKING, extensions: extensions(suggestions()) });
    let provider = suggestions();
    for (const edit of edits) {
      const changes = state.changes(edit(state.doc.toString()));
      state = state.update({ changes }).state;
      provider = provider.flatMap((suggestion) => {
        const mapped = mapSuggestionThroughChanges(suggestion, changes);
        return mapped.destroyed
          ? []
          : [{ ...suggestion, anchors: mapped.anchors, seam: mapped.seam }];
      });
      const fresh = EditorState.create({
        doc: state.doc,
        extensions: extensions(provider),
      });
      assert.deepEqual(shown(state), shown(fresh));
    }
  });
});

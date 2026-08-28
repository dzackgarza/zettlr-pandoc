/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Completion help-link specs (issue #1, review A2 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the US-06 "help from reference completion" entry
 *                  point: every typed label option on the combined @ surface
 *                  carries an info panel whose quick-help link dispatches
 *                  openPandocQuickHelpEffect on the inviting editor view
 *                  (the same signal the MarkdownEditor re-emits for App.vue
 *                  to mount PandocQuickHelp). Citation options stay
 *                  byte-identical to the citation provider and never gain
 *                  the panel — the locked completion differential
 *                  (test/editor-reference-completion.spec.ts) already pins
 *                  that; this spec proves the affordance half.
 *
 * END HEADER
 */

import { type Completion, CompletionContext } from "@codemirror/autocomplete";
import { forceParsing } from "@codemirror/language";
import { EditorState, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import {
  atSymbols,
  referencesUpdate,
} from "source/common/modules/markdown-editor/autocomplete/at-symbols";
import { citekeyUpdate } from "source/common/modules/markdown-editor/autocomplete/citations";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { openPandocQuickHelpEffect } from "source/common/modules/markdown-editor/plugins/pandoc-quick-help-effect";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { type ReferenceCompletionEntry } from "source/types/common/references";

function polyfillJsdomForCodeMirror(): void {
  const w = globalThis as any;
  if (typeof w.requestAnimationFrame !== "function") {
    w.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0);
    w.cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  if (typeof w.window === "object" && typeof w.window.requestAnimationFrame !== "function") {
    w.window.requestAnimationFrame = w.requestAnimationFrame;
    w.window.cancelAnimationFrame = w.cancelAnimationFrame;
  }
  if (typeof w.ResizeObserver !== "function") {
    w.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    if (typeof w.window === "object") {
      w.window.ResizeObserver = w.ResizeObserver;
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== "function") {
    w.Range.prototype.getClientRects = () => [];
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }
}

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const THEOREMS_PATH = path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md");

/** The Theorems.md definitions as typed 'references' database entries. */
function referenceEntries(): ReferenceCompletionEntry[] {
  const snapshot = extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, "utf-8"));
  return snapshot.definitions.map((definition) => ({
    key: definition.key,
    family: definition.family,
    title: definition.title,
    documentPath: definition.documentPath,
  }));
}

const CITATION_DB = [
  {
    citekey: "Ols04",
    displayText: "Olsson — Semistable degenerations and period spaces for polarized K3 surfaces",
  },
];

describe("Completion help link (review A2)", function () {
  const views: EditorView[] = [];
  /** Every openPandocQuickHelpEffect observed on a created view. */
  const observedHelpRequests: Array<StateEffect<unknown>> = [];

  before(function () {
    polyfillJsdomForCodeMirror();
  });

  afterEach(function () {
    observedHelpRequests.splice(0);
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  function createCompletionScene(): { view: EditorView; options: Completion[] } {
    const doc = "See @";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownParser(),
        configField,
        atSymbols.fields ?? [],
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            for (const effect of transaction.effects) {
              if (effect.is(openPandocQuickHelpEffect)) {
                observedHelpRequests.push(effect);
              }
            }
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    assert.ok(
      forceParsing(view, doc.length, 5000),
      "the syntax tree must be fully parsed before asserting",
    );
    view.dispatch({ effects: citekeyUpdate.of(CITATION_DB) });
    view.dispatch({ effects: referencesUpdate.of(referenceEntries()) });

    // The production autocomplete source constructs the context WITH the
    // view (autocomplete/index.ts override), so entries() sees ctx.view.
    const ctx = new CompletionContext(view.state, doc.length, false, view);
    const applies = atSymbols.applies(ctx);
    assert.notStrictEqual(applies, false, "the citation context must trigger the combined surface");
    return { view, options: atSymbols.entries(ctx, "") };
  }

  function labelOptions(options: Completion[]): Completion[] {
    return options.filter((option) => "referenceAffordance" in option);
  }

  it("every label option carries the quick-help info panel; citation options never do", function () {
    const { options } = createCompletionScene();
    const labels = labelOptions(options);
    const citations = options.filter((option) => !("referenceAffordance" in option));
    assert.ok(
      labels.length >= 10,
      `the fixture must feed a representative label set (got ${labels.length})`,
    );
    assert.ok(citations.length >= 1, "the citation database must contribute options");

    for (const label of labels) {
      assert.strictEqual(
        typeof label.info,
        "function",
        `label option ${String(label.label)} must carry the info panel with the quick-help link`,
      );
    }
    for (const citation of citations) {
      // The citation provider authors plain display-text info strings; the
      // injected help panel is function-shaped. Byte-identity of the whole
      // citation option list is locked by the completion differential.
      assert.strictEqual(
        typeof citation.info,
        "string",
        "citation options keep the citation provider's own display-text info (no injected panel)",
      );
    }
  });

  it("the info panel links to the Pandoc quick reference and the link dispatches the open-help effect", async function () {
    const { options } = createCompletionScene();
    const label = labelOptions(options)[0];
    assert.notStrictEqual(label, undefined, "a label option must exist");
    assert.strictEqual(
      typeof label.info,
      "function",
      "the label option must carry an info function",
    );

    const info = await (
      label.info as (completion: Completion) => Node | { dom: Node } | Promise<Node | { dom: Node }>
    )(label);
    const dom = info instanceof Node ? info : info.dom;
    assert.ok(dom instanceof HTMLElement, "the info panel must be a DOM element");

    const link = dom.querySelector<HTMLElement>("[data-open-help]");
    assert.ok(link !== null, "the info panel must expose the quick-help link as [data-open-help]");
    assert.ok(
      (link.textContent ?? "").includes("Pandoc quick reference"),
      "the link must name the quick reference so the affordance is discoverable",
    );

    assert.strictEqual(
      observedHelpRequests.length,
      0,
      "building the panel must not open the help by itself",
    );
    link.click();
    assert.strictEqual(
      observedHelpRequests.length,
      1,
      "clicking the link must dispatch exactly one openPandocQuickHelpEffect on the inviting view",
    );
  });
});

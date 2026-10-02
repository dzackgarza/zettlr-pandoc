/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Statistics Field
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file defines a set of StateFields that are used to keep
 *                  a few statistics such as word counts available to the
 *                  overlying MarkdownEditor instance.
 *
 * END HEADER
 */

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { configField } from "../util/configuration";
import { countDocument } from "../util/word-count";

// The amount of time in milliseconds to wait before triggering word counting
const WORD_COUNT_DELAY = 750;
// The same for a syntax tree that the parser extended below an unchanged
// document: the count follows the part of the document that is parsed
const PARSE_PROGRESS_DELAY = 100;

function count(state: EditorState): { chars: number; words: number } {
  return countDocument(state, state.field(configField).appLang);
}

export const updateWordCountEffect = StateEffect.define<{ chars: number; words: number }>();

export const countField = StateField.define<{ chars: number; words: number }>({
  create(state: EditorState) {
    return count(state);
  },

  update(value, transaction) {
    for (const e of transaction.effects) {
      if (e.is(updateWordCountEffect)) {
        return e.value;
      }
    }

    return value;
  },

  compare(a, b): boolean {
    return a.chars === b.chars && a.words === b.words;
  },
});

export const countPlugin = ViewPlugin.fromClass(
  class {
    private timeout: number | null = null;

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.updateCounts(update.view, WORD_COUNT_DELAY);
      } else if (
        this.timeout === null &&
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.updateCounts(update.view, PARSE_PROGRESS_DELAY);
      }
    }

    updateCounts(view: EditorView, delay: number) {
      if (this.timeout != null) {
        window.clearTimeout(this.timeout);
      }

      this.timeout = window.setTimeout(() => {
        this.timeout = null;

        const counts = count(view.state);
        const shown = view.state.field(countField);
        if (counts.words !== shown.words || counts.chars !== shown.chars) {
          view.dispatch({ effects: updateWordCountEffect.of(counts) });
        }
      }, delay);
    }

    destroy() {
      if (this.timeout != null) {
        window.clearTimeout(this.timeout);
        this.timeout = null;
      }
    }
  },
);

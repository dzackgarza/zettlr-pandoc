/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace edit preview
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The preview of an edit of several documents (#6): each
 *                  document that the edit changes, in the order of a file
 *                  tree, and each changed run of its lines before and
 *                  after. The main process makes it for a proposal and for
 *                  a reference rename; the window shows it. This module
 *                  imports nothing of Node or Electron.
 *
 * END HEADER
 */

import { ChangeSet, Text } from "@codemirror/state";
import type { WorkspaceTextEdit } from "@dts/common/references";
import type {
  WorkspaceEditDocumentPreview,
  WorkspaceEditLineChange,
} from "@dts/common/workspace-edit";
import { diffLines } from "diff";

/** One document of an edit: its text now and its text after the edit. */
export interface ProposedDocument {
  documentPath: string;
  source: string;
  target: string;
}

/** The text of a document after the edits of that document. */
export function editedText(source: string, edits: WorkspaceTextEdit[]): string {
  return ChangeSet.of(
    edits.map((edit) => ({ from: edit.range.from, to: edit.range.to, insert: edit.insert })),
    source.length,
  )
    .apply(Text.of(source.split("\n")))
    .toString();
}

/** A text without its last line end. */
function withoutLastLineEnd(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * The changed runs of lines that take `source` to `target`, from a line diff
 * (jsdiff's `diffLines`). A run is the removed lines and the added lines
 * between two unchanged lines; its line is the first line of the run in
 * `source`, from 1.
 */
export function lineChanges(source: string, target: string): WorkspaceEditLineChange[] {
  const changes: WorkspaceEditLineChange[] = [];
  let line = 1;
  let run: { line: number; before: string; after: string } | undefined;
  for (const part of diffLines(source, target)) {
    if (!part.added && !part.removed) {
      if (run !== undefined) {
        changes.push({
          line: run.line,
          before: withoutLastLineEnd(run.before),
          after: withoutLastLineEnd(run.after),
        });
        run = undefined;
      }
      line += part.count;
      continue;
    }
    run ??= { line, before: "", after: "" };
    if (part.added) {
      run.after += part.value;
    } else {
      run.before += part.value;
      line += part.count;
    }
  }
  if (run !== undefined) {
    changes.push({
      line: run.line,
      before: withoutLastLineEnd(run.before),
      after: withoutLastLineEnd(run.after),
    });
  }
  return changes;
}

/**
 * The order of the documents in a preview: the order of a file tree, where
 * the files of a folder come before its subfolders.
 */
function treeOrder(a: string, b: string): number {
  const left = a.split(/[\\/]/);
  const right = b.split(/[\\/]/);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] === right[index]) {
      continue;
    }
    const leftIsFile = index === left.length - 1;
    const rightIsFile = index === right.length - 1;
    if (leftIsFile !== rightIsFile) {
      return leftIsFile ? -1 : 1;
    }
    return left[index].localeCompare(right[index]);
  }
  return left.length - right.length;
}

/**
 * The documents that the edit changes, in the order of a file tree. A
 * document whose target is its source is not in it.
 */
export function changedDocuments(documents: ProposedDocument[]): ProposedDocument[] {
  return documents
    .filter((document) => document.source !== document.target)
    .sort((a, b) => treeOrder(a.documentPath, b.documentPath));
}

/** The preview of the documents that the edit changes, in the order of a file tree. */
export function previewOf(documents: ProposedDocument[]): WorkspaceEditDocumentPreview[] {
  return changedDocuments(documents).map(({ documentPath, source, target }) => ({
    documentPath,
    changes: lineChanges(source, target),
  }));
}

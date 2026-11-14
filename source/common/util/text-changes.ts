/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Text changes
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The changes that take one text of a document to another,
 *                  as a CodeMirror ChangeSet. A position, a selection and a
 *                  fold of the first text map through them to the second
 *                  text. The diff is jsdiff's (the Myers algorithm). This
 *                  module imports nothing of Node or Electron.
 *
 * END HEADER
 */

import { ChangeSet } from "@codemirror/state";
import { type ChangeObject, diffChars, diffLines } from "diff";

interface TextChange {
  from: number;
  to?: number;
  insert?: string;
}

/**
 * The line diff of a reload gives up above this number of changed lines. The
 * cost of the diff follows the square of the number: 1000 changed lines of
 * 20,000 take about 75 ms.
 */
const MAX_LINE_EDITS = 1000;

/**
 * The character diffs of one reload change at most this number of characters
 * in the replaced runs of lines; 500 take about 20 ms.
 */
const MAX_CHARACTER_EDITS = 500;

/** The changes of a diff whose first part starts at `start`. */
function changesOfDiff(parts: Array<ChangeObject<string>>, start: number): TextChange[] {
  const changes: TextChange[] = [];
  let position = start;
  for (const part of parts) {
    if (part.added) {
      changes.push({ from: position, insert: part.value });
    } else if (part.removed) {
      changes.push({ from: position, to: position + part.value.length });
      position += part.value.length;
    } else {
      position += part.value.length;
    }
  }
  return changes;
}

/** The number of characters that the parts of a diff add or remove. */
function editLength(parts: Array<ChangeObject<string>>): number {
  let length = 0;
  for (const part of parts) {
    if (part.added || part.removed) {
      length += part.value.length;
    }
  }
  return length;
}

/** The changes that take `before` to `after`, from a character diff. */
export function changesBetween(before: string, after: string): ChangeSet {
  return ChangeSet.of(changesOfDiff(diffChars(before, after), 0), before.length);
}

/**
 * The changes that take `before` to `after`, at a cost with a fixed limit:
 * the text of a file that another program wrote can be any text. A line diff
 * finds the runs of lines that changed, and a character diff inside a
 * replaced run keeps a position in a line that only grew. Above
 * `MAX_CHARACTER_EDITS` a replaced run is one change, and above
 * `MAX_LINE_EDITS` the whole text is one change: a position in such a change
 * maps to its start.
 */
export function boundedChangesBetween(before: string, after: string): ChangeSet {
  const lines = diffLines(before, after, { maxEditLength: MAX_LINE_EDITS });
  if (lines === undefined) {
    return ChangeSet.of({ from: 0, to: before.length, insert: after }, before.length);
  }

  const changes: TextChange[] = [];
  let position = 0;
  let characterEdits = MAX_CHARACTER_EDITS;
  for (let index = 0; index < lines.length; index++) {
    const part = lines[index];
    const replacement = part.removed && index + 1 < lines.length ? lines[index + 1] : undefined;
    if (replacement === undefined || !replacement.added) {
      changes.push(...changesOfDiff([part], position));
      position += part.added ? 0 : part.value.length;
      continue;
    }

    const within =
      characterEdits > 0
        ? diffChars(part.value, replacement.value, { maxEditLength: characterEdits })
        : undefined;
    if (within === undefined) {
      characterEdits = 0;
      changes.push({
        from: position,
        to: position + part.value.length,
        insert: replacement.value,
      });
    } else {
      characterEdits -= editLength(within);
      changes.push(...changesOfDiff(within, position));
    }
    position += part.value.length;
    index += 1;
  }
  return ChangeSet.of(changes, before.length);
}

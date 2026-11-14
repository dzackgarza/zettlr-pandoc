/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the changes between two texts of a document
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A reload of an open document maps the place of the author
 *                  through `boundedChangesBetween`. The changes take the old
 *                  text to the new text, a place outside the changed text
 *                  stays at its character.
 *
 * END HEADER
 */

import { strictEqual } from "node:assert";
import { Text } from "@codemirror/state";
import { boundedChangesBetween } from "@common/util/text-changes";

/** A document of `count` paragraphs with a blank line between them. */
function paragraphs(count: number, label: string): string[] {
  return Array.from({ length: count }, (_, index) => `${label} ${index + 1}: an even lattice.`);
}

/** The text that the changes make of `before`. */
function applied(before: string, after: string): string {
  return boundedChangesBetween(before, after)
    .apply(Text.of(before.split("\n")))
    .toString();
}

/** The text around the place that `position` of `before` has in `after`. */
function textAtMappedPlace(before: string, after: string, position: number): string {
  const mapped = boundedChangesBetween(before, after).mapPos(position);
  return after.slice(mapped, mapped + 12);
}

describe("the changes between two texts of a document", function () {
  const lines = paragraphs(400, "Paragraph");
  const before = lines.join("\n\n");
  const place = before.indexOf("lattice", before.indexOf("Paragraph 200:"));

  it("take the old text to the new text", function () {
    const changed = [...lines];
    changed.splice(3, 0, "A line that a program added.");
    changed[250] = `${changed[250]} More text.`;
    changed.pop();
    const after = changed.join("\n\n");
    strictEqual(applied(before, after), after);
    strictEqual(applied(before, before), before);
    strictEqual(applied(before, ""), "");
    strictEqual(applied("", after), after);
  });

  it("keep a place between a change before it and a change after it", function () {
    const changed = [...lines];
    changed.splice(3, 0, "A line that a program added.");
    changed[250] = `${changed[250]} More text.`;
    const after = changed.join("\n\n");
    strictEqual(before.slice(place, place + 12), "lattice.\n\nPa");
    strictEqual(textAtMappedPlace(before, after, place), "lattice.\n\nPa");
  });

  it("keep a place in a line that grew", function () {
    const changed = [...lines];
    changed[199] = `A prefix. ${changed[199]} More text.`;
    const after = changed.join("\n\n");
    strictEqual(textAtMappedPlace(before, after, place), "lattice. Mor");
  });

  it("keep a place outside a line whose text is all new", function () {
    const changed = [...lines];
    changed[100] = "x".repeat(4000);
    const after = changed.join("\n\n");
    strictEqual(applied(before, after), after);
    strictEqual(textAtMappedPlace(before, after, place), "lattice.\n\nPa");
  });

  it("put each place at the start of a text that is all new", function () {
    const after = paragraphs(4000, "Section").join("\n");
    const changes = boundedChangesBetween(paragraphs(4000, "Paragraph").join("\n"), after);
    strictEqual(changes.mapPos(place), 0);
    strictEqual(changes.newLength, after.length);
  });
});

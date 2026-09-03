/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation anchor mapping tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An annotation is a comment on a stretch of text, and the
 *                  owner keeps typing after making it. These cases fix where
 *                  the stretch is afterwards. Each of the eight mapping rules
 *                  has at least one case that fails if only that rule is
 *                  broken, so a mapper that gets seven of them right still
 *                  goes red on the eighth.
 *
 *                  The document is one sentence, and every expectation names
 *                  the text the mapped range must cover in the document the
 *                  change produced — a coordinate pair alone would pass while
 *                  pointing at the wrong words.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import { mapAnnotationThroughChanges } from "@common/util/annotation-anchors";
import type { AnnotationAnchor } from "@dts/common/annotation-domain";

const DOC = "The quick brown fox jumps over the lazy dog.";

/** "brown fox" — the annotated stretch in every case below. */
const TARGET: AnnotationAnchor = {
  state: "range",
  from: 10,
  to: 19,
  quotedText: "brown fox",
};

interface ChangeSpec {
  from: number;
  to?: number;
  insert?: string;
}

/** The changes, and the document they produce. */
function edit(
  spec: ChangeSpec | ChangeSpec[],
  doc: string = DOC,
): { changes: ChangeDesc; after: string } {
  const changes = ChangeSet.of(spec, doc.length);
  return { changes: changes.desc, after: applyTo(doc, changes) };
}

/** The mapped range, and the text it now covers. */
function mapRange(
  anchor: AnnotationAnchor,
  spec: ChangeSpec | ChangeSpec[],
  doc: string = DOC,
): { from: number; to: number; quotedText: string; covers: string; changed: boolean } {
  const changes = ChangeSet.of(spec, doc.length);
  const after = applyTo(doc, changes);
  const mapped = mapAnnotationThroughChanges(anchor, changes.desc);
  assert.equal(mapped.anchor.state, "range", "expected the anchor to stay a range");
  const range = mapped.anchor as Extract<AnnotationAnchor, { state: "range" }>;
  return {
    from: range.from,
    to: range.to,
    quotedText: range.quotedText,
    covers: after.slice(range.from, range.to),
    changed: mapped.changed,
  };
}

function applyTo(doc: string, changes: ChangeSet): string {
  let result = "";
  let cursor = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    result += doc.slice(cursor, fromA) + inserted.toString();
    cursor = toA;
  });
  return result + doc.slice(cursor);
}

describe("Annotation anchor mapping", function () {
  it("verifies the fixture coordinates against the document", function () {
    assert.equal(DOC.slice(10, 19), "brown fox");
    assert.equal(DOC.slice(16, 25), "fox jumps");
  });

  describe("rule 1: a change strictly before the target shifts it", function () {
    it("shifts both coordinates past an insertion", function () {
      const mapped = mapRange(TARGET, { from: 0, insert: "Yesterday " });
      assert.deepEqual(
        { from: mapped.from, to: mapped.to },
        { from: 20, to: 29 },
      );
      assert.equal(mapped.covers, "brown fox");
      assert.equal(mapped.changed, true);
    });

    it("shifts both coordinates back over a deletion", function () {
      const mapped = mapRange(TARGET, { from: 0, to: 4 });
      assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 6, to: 15 });
      assert.equal(mapped.covers, "brown fox");
    });
  });

  describe("rule 2: an insertion on a boundary stays outside the target", function () {
    it("leaves text typed at the start boundary before the target", function () {
      const mapped = mapRange(TARGET, { from: 10, insert: "very " });
      assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 15, to: 24 });
      assert.equal(mapped.covers, "brown fox");
    });

    it("leaves text typed at the end boundary after the target", function () {
      const mapped = mapRange(TARGET, { from: 19, insert: " indeed" });
      assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 10, to: 19 });
      assert.equal(mapped.covers, "brown fox");
      assert.equal(mapped.changed, false);
    });
  });

  it("rule 3: an insertion inside the target expands it", function () {
    const mapped = mapRange(TARGET, { from: 15, insert: "ish" });
    assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 10, to: 22 });
    assert.equal(mapped.covers, "brownish fox");
  });

  it("rule 4: a replacement inside the target is covered by it", function () {
    const mapped = mapRange(TARGET, { from: 16, to: 19, insert: "wolverine" });
    assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 10, to: 25 });
    assert.equal(mapped.covers, "brown wolverine");
  });

  it("rule 5: deleting part of the target shrinks it", function () {
    const mapped = mapRange(TARGET, { from: 12, to: 15 });
    assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 10, to: 16 });
    assert.equal(mapped.covers, "br fox");
  });

  describe("rule 6: deleting the whole target collapses it to a point", function () {
    it("keeps the quoted text and marks the seam", function () {
      const { changes } = edit({ from: 10, to: 19 });
      const mapped = mapAnnotationThroughChanges(TARGET, changes);
      assert.deepEqual(mapped.anchor, {
        state: "point",
        at: 10,
        quotedText: "brown fox",
        reason: "target-deleted",
      });
      assert.equal(mapped.changed, true);
    });

    it("collapses to the seam of a deletion that reaches past the target", function () {
      const { changes } = edit({ from: 9, to: 25 });
      const mapped = mapAnnotationThroughChanges(TARGET, changes);
      assert.deepEqual(mapped.anchor, {
        state: "point",
        at: 9,
        quotedText: "brown fox",
        reason: "target-deleted",
      });
    });

    it("collapses when a wider rewrite swallows the target", function () {
      const { changes } = edit({ from: 9, to: 25, insert: " a wolf" });
      const mapped = mapAnnotationThroughChanges(TARGET, changes);
      assert.deepEqual(mapped.anchor, {
        state: "point",
        at: 9,
        quotedText: "brown fox",
        reason: "target-deleted",
      });
    });
  });

  it("rule 4, at its limit: a rewrite of exactly the target is followed", function () {
    const mapped = mapRange(TARGET, { from: 10, to: 19, insert: "grey wolf" });
    assert.deepEqual({ from: mapped.from, to: mapped.to }, { from: 10, to: 19 });
    assert.equal(mapped.covers, "grey wolf");
    assert.equal(mapped.quotedText, "brown fox");
  });

  it("rule 7: an orphaned anchor passes through untouched", function () {
    const orphan: AnnotationAnchor = {
      state: "orphaned",
      quotedText: "brown fox",
      reason: "external-drift",
    };
    const { changes } = edit({ from: 0, insert: "Yesterday " });
    const mapped = mapAnnotationThroughChanges(orphan, changes);
    assert.deepEqual(mapped.anchor, orphan);
    assert.equal(mapped.changed, false);
  });

  describe("rule 8: overlapping annotations map independently", function () {
    const second: AnnotationAnchor = {
      state: "range",
      from: 16,
      to: 25,
      quotedText: "fox jumps",
    };

    it("maps each of two overlapping targets to its own text", function () {
      const first = mapRange(TARGET, { from: 15, insert: "ish" });
      const other = mapRange(second, { from: 15, insert: "ish" });
      assert.equal(first.covers, "brownish fox");
      assert.equal(other.covers, "fox jumps");
      assert.deepEqual({ from: other.from, to: other.to }, { from: 19, to: 28 });
    });

    it("gives the same result whichever target is mapped first", function () {
      const { changes } = edit({ from: 15, insert: "ish" });
      const forward = [TARGET, second].map((a) => mapAnnotationThroughChanges(a, changes));
      const backward = [second, TARGET].map((a) => mapAnnotationThroughChanges(a, changes));
      assert.deepEqual(forward[0].anchor, backward[1].anchor);
      assert.deepEqual(forward[1].anchor, backward[0].anchor);
    });
  });

  describe("a collapsed point keeps travelling with the document", function () {
    const seam: AnnotationAnchor = {
      state: "point",
      at: 10,
      quotedText: "brown fox",
      reason: "target-deleted",
    };
    const AFTER_DELETION = "The quick  jumps over the lazy dog.";

    it("shifts past an earlier insertion", function () {
      const { changes } = edit({ from: 0, insert: "Yesterday " }, AFTER_DELETION);
      const mapped = mapAnnotationThroughChanges(seam, changes);
      assert.deepEqual(mapped.anchor, { ...seam, at: 20 });
    });

    it("stays at the head of text typed into the seam", function () {
      const { changes } = edit({ from: 10, insert: "grey wolf" }, AFTER_DELETION);
      const mapped = mapAnnotationThroughChanges(seam, changes);
      assert.deepEqual(mapped.anchor, seam);
      assert.equal(mapped.changed, false);
    });

    it("does not become a range again when the deletion is undone", function () {
      const { changes } = edit({ from: 10, insert: "brown fox" }, AFTER_DELETION);
      const mapped = mapAnnotationThroughChanges(seam, changes);
      assert.equal(mapped.anchor.state, "point");
    });
  });

  it("returns to its original coordinates when an insertion is undone", function () {
    const expanded = mapRange(TARGET, { from: 15, insert: "ish" });
    const restored = mapRange(
      { state: "range", from: expanded.from, to: expanded.to, quotedText: "brown fox" },
      { from: 15, to: 18 },
      "The quick brownish fox jumps over the lazy dog.",
    );
    assert.deepEqual({ from: restored.from, to: restored.to }, { from: 10, to: 19 });
    assert.equal(restored.covers, "brown fox");
  });

  it("never rewrites the quoted text", function () {
    const cases: Array<ChangeSpec | ChangeSpec[]> = [
      { from: 0, insert: "Yesterday " },
      { from: 15, insert: "ish" },
      { from: 16, to: 19, insert: "wolverine" },
      { from: 12, to: 15 },
    ];
    for (const spec of cases) {
      assert.equal(mapRange(TARGET, spec).quotedText, "brown fox");
    }
  });
});

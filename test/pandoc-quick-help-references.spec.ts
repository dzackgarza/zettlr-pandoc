/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The theorem-family examples of the Pandoc quick help
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The quick help shows for each theorem family the fenced
 *                  div that an author types and the reference that cites it.
 *                  `THEOREM_DIV_EXAMPLES` builds both from
 *                  `THEOREM_FAMILY_METADATA`, so a spec that reads the
 *                  registry again proves nothing about what the help shows.
 *                  The table here is written by hand: each row is the text
 *                  that an author sees and types (#57, row V13).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { THEOREM_DIV_EXAMPLES } from "source/common/util/pandoc-quick-reference";

/** What the quick help shows for each family: its name, its div and its reference. */
const SHOWN: ReadonlyArray<readonly [name: string, label: string, reference: string]> = [
  ["Theorem", "::: {.theorem #thm:key}", "@thm:key"],
  ["Lemma", "::: {.lemma #lem:key}", "@lem:key"],
  ["Proposition", "::: {.proposition #prop:key}", "@prop:key"],
  ["Corollary", "::: {.corollary #cor:key}", "@cor:key"],
  ["Definition", "::: {.definition #def:key}", "@def:key"],
  ["Remark", "::: {.remark #rmk:key}", "@rmk:key"],
  ["Example", "::: {.example #ex:key}", "@ex:key"],
  ["Conjecture", "::: {.conjecture #conj:key}", "@conj:key"],
  ["Claim", "::: {.claim #clm:key}", "@clm:key"],
  ["Observation", "::: {.observation #obs:key}", "@obs:key"],
  ["Question", "::: {.question #qst:key}", "@qst:key"],
  ["Problem", "::: {.problem #prob:key}", "@prob:key"],
  ["Assumption", "::: {.assumption #ass:key}", "@ass:key"],
  ["Warning", "::: {.warning #warn:key}", "@warn:key"],
  ["Exercise", "::: {.exercise #exr:key}", "@exr:key"],
  ["Construction", "::: {.construction #cons:key}", "@cons:key"],
  ["Notation", "::: {.notation #not:key}", "@not:key"],
  ["Convention", "::: {.convention #conv:key}", "@conv:key"],
];

describe("The theorem-family examples of the Pandoc quick help", function () {
  it("shows each family with the div that an author types and the reference that cites it", function () {
    assert.deepEqual(
      THEOREM_DIV_EXAMPLES.map((example) => [
        example.displayName,
        example.label,
        example.reference,
      ]),
      SHOWN,
    );
  });

  it("shows no proof-like div: no reference cites a proof", function () {
    for (const proofLike of ["proof", "sketch", "solution"]) {
      assert.equal(
        THEOREM_DIV_EXAMPLES.some((example) => example.label.includes(`.${proofLike} `)),
        false,
        `the help has no example for ${proofLike}`,
      );
    }
  });
});

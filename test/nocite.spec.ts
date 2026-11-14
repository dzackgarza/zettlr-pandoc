/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The keys of the front matter field nocite
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The References view lists the items that Pandoc puts into
 *                  the bibliography of a document that does not cite them.
 *                  The oracle is Pandoc 3.11: `pandoc -t json` of a document
 *                  with each value of `nocite`, and the `citationId` of each
 *                  citation in its metadata.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { uncitedItems } from "@common/util/nocite";

describe("the keys of the front matter field nocite", function () {
  const pandocReadings: Array<[string | string[], string[]]> = [
    ["@a @b", ["a", "b"]],
    ["@a, @b", ["a", "b"]],
    ["[@a; @b]", ["a", "b"]],
    [
      ["@a", "@b @c"],
      ["a", "b", "c"],
    ],
    ["see @a", ["a"]],
  ];

  for (const [nocite, keys] of pandocReadings) {
    it(`reads ${JSON.stringify(nocite)} as Pandoc does`, function () {
      assert.deepEqual(uncitedItems(nocite), { keys, all: false });
    });
  }

  it("reads @* as each item of the bibliography", function () {
    assert.deepEqual(uncitedItems("@*"), { keys: [], all: true });
    assert.deepEqual(uncitedItems(["@a", "@*"]), { keys: ["a"], all: true });
  });

  it("reads no citation in @* inside a word, as Pandoc does", function () {
    assert.deepEqual(uncitedItems("x@* y"), { keys: [], all: false });
  });
});

/** Integration contract for the vendored @lezer/markdown Pandoc fork. */

import { strict as assert } from "node:assert";
import { commonmarkLanguage, markdownLanguage } from "@codemirror/lang-markdown";
import { createPandocParser, MarkdownParser, Pandoc } from "@lezer/markdown";

/**
 * @codemirror/lang-markdown performs an `instanceof MarkdownParser` check on
 * its base parser. A nested second copy of @lezer/markdown therefore breaks the
 * fork even when both copies contain byte-identical code. The package-manager
 * resolution must keep CodeMirror and the application on one constructor.
 */
describe("vendored Pandoc Lezer fork integration", function () {
  it("shares the exact MarkdownParser class with @codemirror/lang-markdown", function () {
    assert.ok(commonmarkLanguage.parser instanceof MarkdownParser);
    assert.ok(markdownLanguage.parser instanceof MarkdownParser);
  });

  it("constructs the Pandoc parser from the same class identity", function () {
    const parser = createPandocParser({ wikilinks: "link|title" });
    assert.ok(parser instanceof MarkdownParser);
    assert.ok(commonmarkLanguage.parser instanceof MarkdownParser);
    assert.doesNotThrow(() => (commonmarkLanguage.parser as MarkdownParser).configure(Pandoc()));
  });

  it("parses a long paragraph of adjacent bracketed labels promptly", function () {
    for (const suffix of [
      "[label]",
      "[@key]",
      "[@key][reference]",
      "[@key](target)",
      "[@key]{.class}",
    ]) {
      const source = (`[name]${suffix} ` + "text ".repeat(16)).repeat(15);
      const start = performance.now();
      const tree = createPandocParser().parse(source);

      assert.equal(tree.length, source.length);
      assert.ok(performance.now() - start < 2000, "parsing blocked the main process");
    }
  });
});

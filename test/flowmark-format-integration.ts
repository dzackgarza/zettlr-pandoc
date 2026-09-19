/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        REAL-toolchain flowmark integration proof (issue #26)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the production flowmark service with NO injected
 *                  runner, so it exercises the exact production command string
 *                  against the Flowmark source pinned in vendor/flowmark, rather
 *                  than a network-selected revision. It proves both the formatter
 *                  and the standalone linter through the same production runtime.
 *
 *                  A cold uv cache may install Flowmark's Python dependencies,
 *                  so it is not a `*.spec.ts` file in the fastest default suite.
 *                  Run it explicitly with the dedicated recipe:
 *                  `just test-flowmark-integration`. When flowmark cannot be
 *                  launched at all, formatMarkdownText returns a typed
 *                  `flowmark-absent`, and the `ok === true` assertion fails loudly
 *                  — the lane never silently skips.
 *
 *                  The owned interlock proven here is that OUR production command
 *                  string, run through the service's write-temp -> run -> read-back
 *                  roundtrip, produces flowmark's semantic reflow — not that
 *                  flowmark is correct in general.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { formatMarkdownText } from "source/app/util/flowmark-format";
import { lintMarkdownText } from "source/app/util/flowmark-lint";

describe("flowmark real-toolchain integration (issue #26)", function () {
  // A cold uv cache may need to install the pinned project's dependencies.
  this.timeout(180000);

  it("runs the production uvx flowmark command and applies the --semantic reflow", async function () {
    // A single physical line holding two sentences. --semantic reflow must
    // break it into one sentence per line; if the production command string
    // were wrong the runner would not launch (flowmark-absent) and `ok` would
    // be false, so this asserts the real invocation, not a stand-in.
    const input = "The cat sat. The dog ran.\n";
    assert.equal(input.trimEnd().includes("\n"), false, "premise: input is a single physical line");

    // No opts -> the real FLOWMARK_COMMAND + FLOWMARK_ARGS_PREFIX are used.
    const result = await formatMarkdownText(input);

    assert.equal(result.ok, true, "the real production flowmark invocation must launch and exit 0");
    if (result.ok) {
      assert.notEqual(
        result.formatted,
        input,
        "the semantic reflow must actually change the buffer",
      );
      const lines = result.formatted
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      assert.deepEqual(
        lines,
        ["The cat sat.", "The dog ran."],
        "flowmark --semantic must place each sentence on its own line",
      );
    }
  });

  it("runs the pinned submodule linter and treats TeX math as math, not Markdown emphasis", async function () {
    const result = await lintMarkdownText(
      "The classes $x_i$, \\(y_j\\), and \\underline{z_k} are mathematical.\n",
    );
    assert.equal(result.ok, true, "the vendored Flowmark linter must launch successfully");
    if (result.ok) {
      assert.deepEqual(
        result.diagnostics,
        [],
        "underscores in parsed math/raw TeX must not become Markdown-emphasis findings",
      );
    }
  });

  it("does not turn formatter normalization into editor lint", async function () {
    const result = await lintMarkdownText("Use _emphasis_ in prose.\n");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.diagnostics,
        [],
        "a spelling the formatter would normalize is not a semantic defect",
      );
    }
  });

  it("reports mathematical defects that normalization cannot decide", async function () {
    const result = await lintMarkdownText(
      "The map $Hom_R(M,N)$ has component $x_i_j$ and value $x_{i$.\n",
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      const rules = new Set(result.diagnostics.map((diagnostic) => diagnostic.rule));
      assert.ok(rules.has("math/bare-operator"));
      assert.ok(rules.has("math/repeated-subscript"));
      assert.ok(rules.has("math/unclosed-group"));
      assert.equal(rules.has("format/canonical"), false);
    }
  });

  it("passes the active document path so relative-link diagnostics use the editor location", async function () {
    const dir = await mkdtemp(path.join(tmpdir(), "zettlr-flowmark-lint-path-"));
    try {
      const result = await lintMarkdownText(
        "---\ncsl: styles/does-not-exist.csl\n---\n\n[missing](does-not-exist.md)\n",
        {
          sourcePath: path.join(dir, "document.md"),
        },
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        const rules = new Set(result.diagnostics.map((diagnostic) => diagnostic.rule));
        assert.ok(
          rules.has("link/missing-local-target"),
          "relative links must be resolved against the active document path, not the process cwd",
        );
        assert.ok(
          rules.has("pandoc/missing-resource"),
          "Pandoc frontmatter resources must resolve against the active document path",
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

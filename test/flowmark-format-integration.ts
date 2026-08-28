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
 *                  (`uvx --from git+…/flowmark.git flowmark --inplace --nobackup
 *                  --semantic --no-respect-gitignore <file>`) against the REAL
 *                  flowmark binary end-to-end and asserts flowmark's `--semantic`
 *                  reflow (sentence-per-line). This is the committed backing for
 *                  the PR claim that the real invocation is verified end-to-end.
 *
 *                  This fetches flowmark from git via uvx (network), so it is NOT
 *                  a `*.spec.ts` file and is excluded from the default `just test`
 *                  commit gate. Run it explicitly with the dedicated recipe:
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
import { formatMarkdownText } from "source/app/util/flowmark-format";

describe("flowmark real-toolchain integration (issue #26)", function () {
  // uvx fetches flowmark from git on a cold cache; allow generously for it.
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
});

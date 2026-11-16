/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Limits and lists that two files of the repository share
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Some facts of the repository are written in two files that
 *                  nothing else compares: the time that the launcher waits
 *                  for a rebuild and the time limit of the build; the spec
 *                  files that the recipes of the justfile name; the files of
 *                  the typecheck. Each test reads the two files (#57, rows
 *                  YZQra, WS-Tr and YjPxM).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPOSITORY = path.resolve(__dirname, "..");

function read(file: string): string {
  return readFileSync(path.join(REPOSITORY, file), "utf8");
}

/** The whole number that a pattern with one group finds in a file. */
function numberIn(file: string, pattern: RegExp): number {
  const found = pattern.exec(read(file));
  assert.ok(found !== null, `${file} has a line that matches ${String(pattern)}`);
  return Number(found[1]);
}

describe("Limits and lists that two files of the repository share", function () {
  it("lets the launcher wait for a rebuild longer than the build may take", function () {
    const launchWaitsSeconds = numberIn(
      "scripts/desktop/zettlr-pandoc-boot",
      /^rebuild_launch_timeout=(\d+)$/m,
    );
    const buildLimitSeconds = numberIn("scripts/verify-build.py", /^BUILD_TIMEOUT_S = (\d+)$/m);

    assert.ok(
      launchWaitsSeconds > buildLimitSeconds,
      `the launcher waits ${launchWaitsSeconds} s for a rebuild, and the build may take ${buildLimitSeconds} s`,
    );
  });

  it("names in the recipes of the justfile only spec files that exist", function () {
    const named = [...read("justfile").matchAll(/"((?:test|e2e)\/[^"\s{}]+\.ts)"/g)].map(
      (match) => match[1],
    );

    assert.ok(named.length > 0, "the justfile names spec files");
    assert.deepEqual(
      named.filter((file) => !existsSync(path.join(REPOSITORY, file))),
      [],
      "each spec file that a recipe names is in the repository",
    );
  });

  it("has the specs and their fixtures in the typecheck", function () {
    // The fixtures of the contract hold `@ts-expect-error` lines: they prove
    // a refusal of the compiler only while the typecheck reads them.
    const include: unknown = JSON.parse(read("tsconfig.json")).include;

    assert.ok(Array.isArray(include), "tsconfig.json has a list of included files");
    for (const pattern of ["source/**/*", "test/**/*", "e2e/**/*"]) {
      assert.ok(include.includes(pattern), `the typecheck includes ${pattern}`);
    }
    assert.match(
      String(JSON.parse(read("package.json")).scripts.typecheck),
      /vue-tsc --noEmit/,
      "the typecheck script runs the compiler over that list",
    );
  });
});

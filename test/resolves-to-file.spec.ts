/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        resolvesToFile / isFile symlink-semantics specs (issue #5, B12)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the deliberate behavioral split between the two
 *                  shared file predicates: isFile() (lstat — the path entry
 *                  itself must be a regular file, a symlink never is) and
 *                  resolvesToFile() (stat — the symlink-RESOLVED target must
 *                  be a regular file). The boot preflight depends on the
 *                  following variant: a symlinked ~/.pandoc/justfile must
 *                  satisfy the requiredPaths() check.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { findMissingRequirements } from "source/app/util/preflight";
import isFile from "source/common/util/is-file";
import resolvesToFile from "source/common/util/resolves-to-file";

describe("resolvesToFile() vs isFile() symlink semantics (issue #5, B12)", function () {
  let scratch: string;
  let regularFile: string;
  let fileLink: string;
  let danglingLink: string;
  let directory: string;

  before(async function () {
    scratch = await mkdtemp(path.join(os.tmpdir(), "zettlr-resolves-to-file-"));
    regularFile = path.join(scratch, "justfile");
    fileLink = path.join(scratch, "justfile-link");
    danglingLink = path.join(scratch, "dangling-link");
    directory = path.join(scratch, "a-directory");
    await writeFile(regularFile, "compile-pandoc:\n\techo ok\n", "utf-8");
    await symlink(regularFile, fileLink);
    await symlink(path.join(scratch, "no-such-target"), danglingLink);
    await mkdir(directory);
  });

  after(async function () {
    await rm(scratch, { recursive: true, force: true });
  });

  it("both predicates accept a regular file and reject a missing path", function () {
    assert.equal(resolvesToFile(regularFile), true);
    assert.equal(isFile(regularFile), true);
    const missing = path.join(scratch, "definitely-missing");
    assert.equal(resolvesToFile(missing), false);
    assert.equal(isFile(missing), false);
  });

  it("resolvesToFile follows a symlink to a file where isFile (lstat) rejects it", function () {
    // THE distinction the two helpers exist for: reverting preflight to the
    // lstat helper turns this row false.
    assert.equal(resolvesToFile(fileLink), true);
    assert.equal(isFile(fileLink), false);
  });

  it("both predicates reject a dangling symlink and a directory", function () {
    assert.equal(resolvesToFile(danglingLink), false);
    assert.equal(isFile(danglingLink), false);
    assert.equal(resolvesToFile(directory), false);
    assert.equal(isFile(directory), false);
  });

  it("preflight accepts a symlinked required path (the ~/.pandoc/justfile case)", async function () {
    // The consumer-level claim of B12: findMissingRequirements must treat a
    // symlinked requirement target as present.
    const missing = await findMissingRequirements(
      [],
      [{ target: fileLink, purpose: "symlinked recipe file" }],
    );
    assert.deepEqual(missing, []);
  });
});

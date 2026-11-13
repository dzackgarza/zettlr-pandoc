/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Stat failure tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The predicates that ask the filesystem what a path is
 *                  answer "no" only when nothing is at the path. A path that
 *                  the filesystem could not examine has no answer, and the
 *                  predicate throws.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import FSAL from "source/app/service-providers/fsal";
import isDir from "source/common/util/is-dir";
import isFile from "source/common/util/is-file";
import resolvesToFile from "source/common/util/resolves-to-file";

describe("stat predicates", function () {
  let root: string;
  let file: string;
  let directory: string;
  let belowFile: string;
  let belowLoop: string;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-stat-failures-"));
    file = path.join(root, "document.md");
    directory = path.join(root, "folder");
    belowFile = path.join(file, "child.md");
    // A symbolic link to itself: the filesystem cannot walk through it, so a
    // stat of a path below it fails with ELOOP.
    const loop = path.join(root, "loop");
    belowLoop = path.join(loop, "child.md");
    await writeFile(file, "Document\n");
    await mkdir(directory);
    await symlink(loop, loop);
  });

  after(async function () {
    await rm(root, { recursive: true, force: true });
  });

  it("answer for a file, a directory and a path that is below a file", async function () {
    assert.deepEqual(
      {
        isFile: [isFile(file), isFile(directory), isFile(belowFile)],
        isDir: [isDir(file), isDir(directory), isDir(belowFile)],
        resolvesToFile: [
          resolvesToFile(file),
          resolvesToFile(directory),
          resolvesToFile(belowFile),
        ],
        fsalIsFile: [
          await FSAL.prototype.isFile(file),
          await FSAL.prototype.isFile(directory),
          await FSAL.prototype.isFile(belowFile),
        ],
        fsalIsDir: [
          await FSAL.prototype.isDir(file),
          await FSAL.prototype.isDir(directory),
          await FSAL.prototype.isDir(belowFile),
        ],
      },
      {
        isFile: [true, false, false],
        isDir: [false, true, false],
        resolvesToFile: [true, false, false],
        fsalIsFile: [true, false, false],
        fsalIsDir: [false, true, false],
      },
    );
  });

  it("isFile throws for a path that the filesystem cannot examine", function () {
    assert.throws(() => isFile(belowLoop), { code: "ELOOP" });
  });

  it("isDir throws for a path that the filesystem cannot examine", function () {
    assert.throws(() => isDir(belowLoop), { code: "ELOOP" });
  });

  it("resolvesToFile throws for a path that the filesystem cannot examine", function () {
    assert.throws(() => resolvesToFile(belowLoop), { code: "ELOOP" });
  });

  it("the FSAL predicates reject for a path that the filesystem cannot examine", async function () {
    await assert.rejects(FSAL.prototype.isFile(belowLoop), { code: "ELOOP" });
    await assert.rejects(FSAL.prototype.isDir(belowLoop), { code: "ELOOP" });
  });
});

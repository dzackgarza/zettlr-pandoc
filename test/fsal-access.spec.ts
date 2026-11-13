/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL access check tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The access checks of the FSAL answer true or false for a
 *                  path that the filesystem examined. An access check that
 *                  the filesystem could not do is a failure, and rejects.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import FSAL from "source/app/service-providers/fsal";

const READ_WRITE = constants.F_OK | constants.R_OK | constants.W_OK;

describe("FSAL access checks", function () {
  let root: string;
  let document: string;
  let readOnly: string;
  let missing: string;
  let belowFile: string;
  let looped: string;

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-access-"));
    document = path.join(root, "document.md");
    readOnly = path.join(root, "read-only.md");
    missing = path.join(root, "missing.md");
    belowFile = path.join(document, "child.md");
    looped = path.join(root, "looped.md");
    await writeFile(document, "Document\n");
    await writeFile(readOnly, "Read only\n");
    await chmod(readOnly, 0o444);
    // A symbolic link to itself: the filesystem cannot follow it (ELOOP).
    await symlink(looped, looped);
  });

  afterEach(async function () {
    await rm(root, { recursive: true, force: true });
  });

  it("testAccess answers for a path that the filesystem examined", async function () {
    assert.deepEqual(
      {
        document: await FSAL.prototype.testAccess(document, READ_WRITE),
        readOnlyForReading: await FSAL.prototype.testAccess(readOnly, constants.R_OK),
        readOnlyForWriting: await FSAL.prototype.testAccess(readOnly, READ_WRITE),
        missing: await FSAL.prototype.testAccess(missing, READ_WRITE),
        belowFile: await FSAL.prototype.testAccess(belowFile, READ_WRITE),
      },
      {
        document: true,
        readOnlyForReading: true,
        readOnlyForWriting: false,
        missing: false,
        belowFile: false,
      },
    );
  });

  it("testAccess rejects when the filesystem cannot examine the path", async function () {
    await assert.rejects(FSAL.prototype.testAccess(looped, READ_WRITE), { code: "ELOOP" });
  });

  it("pathExists answers for a path that the filesystem examined", async function () {
    assert.deepEqual(
      {
        document: await FSAL.prototype.pathExists(document),
        missing: await FSAL.prototype.pathExists(missing),
        belowFile: await FSAL.prototype.pathExists(belowFile),
      },
      { document: true, missing: false, belowFile: false },
    );
  });

  it("pathExists rejects when the filesystem cannot examine the path", async function () {
    await assert.rejects(FSAL.prototype.pathExists(looped), { code: "ELOOP" });
  });
});

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL text file write tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Writes text files through the REAL FSAL. A reader of a
 *                  file that the FSAL writes gets the text before the write
 *                  or the text after it, at each moment of the write. The
 *                  write keeps what the file is: its mode, its other names
 *                  (hard links), the symbolic link that names it, and the
 *                  refusal of a file that the author may not write (#211).
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type FSAL from "source/app/service-providers/fsal";
import { bootFsal } from "./fsal-seam";

const BEFORE = "A lattice is a free abelian group of finite rank with a bilinear form.\n";
const AFTER = "The discriminant group of an even lattice has a quadratic form.\n";
// A document of this size takes many write calls, so a write in place leaves
// a part of the text in the file for a time that a reader can meet.
const LONG_BEFORE = BEFORE.repeat(60_000);
const LONG_AFTER = AFTER.repeat(60_000);

describe("FSAL text file write", function () {
  let root: string;
  let document: string;
  let fsal: FSAL;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-write-"));
    // The files of the cases are beside the workspace, so the watcher of the
    // FSAL reads none of them.
    await mkdir(path.join(root, "workspace"));
    fsal = await bootFsal(path.join(root, "workspace"));
  });

  beforeEach(async function () {
    document = path.join(await mkdtemp(path.join(root, "case-")), "lattice.md");
    await writeFile(document, BEFORE);
  });

  after(async function () {
    await fsal.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("gives a reader the text before the write or the text after it", async function () {
    await writeFile(document, LONG_BEFORE);
    const otherReads: string[] = [];
    let reads = 0;

    for (let round = 0; round < 5; round++) {
      for (const text of [LONG_AFTER, LONG_BEFORE]) {
        let writing = true;
        const write = fsal.writeTextFile(document, text).finally(() => {
          writing = false;
        });
        while (writing) {
          const read = await readFile(document, "utf8");
          reads += 1;
          if (read !== LONG_BEFORE && read !== LONG_AFTER) {
            otherReads.push(`${read.length} characters`);
          }
        }
        await write;
        assert.equal(await readFile(document, "utf8"), text, "the write puts its text in the file");
      }
    }

    assert.ok(reads >= 10, `a reader read during each write (${reads} reads)`);
    assert.deepEqual(otherReads, [], "each read is the text before or the text after a write");
    assert.deepEqual(
      await readdir(path.dirname(document)),
      ["lattice.md"],
      "the writes leave no other file in the directory",
    );
  });

  it("keeps the mode of the file", async function () {
    await chmod(document, 0o640);

    await fsal.writeTextFile(document, AFTER);

    assert.equal((await stat(document)).mode & 0o777, 0o640);
    assert.equal(await readFile(document, "utf8"), AFTER);
  });

  it("writes through a symbolic link to the file that the link names", async function () {
    const linked = path.join(path.dirname(document), "linked.md");
    await symlink(document, linked);

    await fsal.writeTextFile(linked, AFTER);

    assert.ok((await lstat(linked)).isSymbolicLink(), "the link is a link after the write");
    assert.equal(await readFile(document, "utf8"), AFTER);
  });

  it("writes the text to each name of a file with two names", async function () {
    const secondName = path.join(path.dirname(document), "second-name.md");
    await link(document, secondName);

    await fsal.writeTextFile(document, AFTER);

    assert.deepEqual(
      [await readFile(document, "utf8"), await readFile(secondName, "utf8")],
      [AFTER, AFTER],
    );
    assert.equal((await stat(document)).nlink, 2, "the two names are one file after the write");
  });

  it("refuses a file that the author may not write, in a directory that the author may write", async function () {
    await chmod(document, 0o400);

    await assert.rejects(fsal.writeTextFile(document, AFTER), { code: "EACCES" });

    assert.equal(await readFile(document, "utf8"), BEFORE, "the file keeps its text");
    assert.equal((await stat(document)).mode & 0o777, 0o400, "the file keeps its mode");
  });

  it("writes a file that the author may write, in a directory that the author may not write", async function () {
    const directory = path.dirname(document);
    await chmod(directory, 0o500);

    await fsal.writeTextFile(document, AFTER).finally(async () => {
      await chmod(directory, 0o700);
    });

    assert.equal(await readFile(document, "utf8"), AFTER);
  });

  it("creates a file that does not exist", async function () {
    const created = path.join(path.dirname(document), "notes", "new.md");
    await mkdir(path.dirname(created));

    await fsal.writeTextFile(created, AFTER);

    assert.equal(await readFile(created, "utf8"), AFTER);
  });
});

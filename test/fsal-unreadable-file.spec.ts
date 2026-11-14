/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL tests of a file whose text cannot be read
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace holds a Markdown file and a code file that
 *                  the user of the process may not read. The FSAL indexes
 *                  the workspace, gives each file a descriptor that carries
 *                  the cause, and reads the file when it is readable again.
 *                  These tests run the real FSAL over a directory on disk.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type FSAL from "source/app/service-providers/fsal";
import { bootFsal } from "./fsal-seam";
import { invokeMain } from "./main-ipc";

describe("FSAL: a file whose text cannot be read", function () {
  let root: string;
  let readable: string;
  let unreadable: string;
  let unreadableCode: string;
  let fsal: FSAL;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-unreadable-"));
    readable = path.join(root, "note.md");
    unreadable = path.join(root, "other.md");
    unreadableCode = path.join(root, "macros.tex");
    await writeFile(readable, "# Lattices\n\nAn even unimodular lattice.\n");
    await writeFile(unreadable, "# Genera\n\nTwo forms of one genus.\n");
    await writeFile(unreadableCode, "\\newcommand{\\ZZ}{\\mathbb{Z}}\n");
    await chmod(unreadable, 0o000);
    await chmod(unreadableCode, 0o000);
    fsal = await bootFsal(root);
  });

  after(async function () {
    await fsal.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("indexes the workspace that holds the file", async function () {
    await fsal.reindexFiles();
    const indexed = await fsal.getDescriptorFor(readable);
    assert.equal(indexed.type, "file");
    assert.equal(indexed.type === "file" ? indexed.firstHeading : null, "Lattices");
  });

  it("gives the file a descriptor that carries the cause", async function () {
    const markdown = await fsal.getDescriptorFor(unreadable);
    const code = await fsal.getDescriptorFor(unreadableCode);
    assert.deepEqual(
      [markdown.type, code.type, markdown.path, code.path],
      ["file", "code", unreadable, unreadableCode],
    );
    assert.equal(
      markdown.type === "file" ? markdown.readError?.code : undefined,
      "EACCES",
      "the Markdown descriptor names the cause",
    );
    assert.equal(
      code.type === "code" ? code.readError?.code : undefined,
      "EACCES",
      "the code descriptor names the cause",
    );
    const other = await fsal.getDescriptorFor(readable);
    assert.equal(
      other.type === "file" ? other.readError : null,
      undefined,
      "a file that was read carries no cause",
    );
  });

  it("answers the descriptors of every path that a window asks for", async function () {
    const descriptors = await invokeMain("fsal", {
      command: "get-descriptors",
      payload: [readable, unreadable, unreadableCode],
    });
    assert.ok(Array.isArray(descriptors), "a list of paths is answered with a list of descriptors");
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.path),
      [readable, unreadable, unreadableCode],
    );
  });

  it("reads the file when it is readable again", async function () {
    await chmod(unreadable, 0o600);
    const descriptor = await fsal.getDescriptorFor(unreadable);
    assert.equal(descriptor.type, "file");
    assert.deepEqual(
      descriptor.type === "file" ? [descriptor.firstHeading, descriptor.readError] : [],
      ["Genera", undefined],
    );
  });
});

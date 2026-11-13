/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the type of a file
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The type of a file is the type that its extension names,
 *                  whatever the case of the extension: `Notes.MD` is a
 *                  Markdown file, `Paper.PDF` a PDF, `Figure.PNG` and
 *                  `photo.webp` images (#203). The FSAL tests run the real
 *                  FSAL over a directory on disk.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type FSAL from "source/app/service-providers/fsal";
import { createIgnoreFilter, EVERY_FILE_TYPE } from "source/common/util/ignore-rules";
import { bootFilteredFsal } from "./fsal-seam";

describe("The type of a file", function () {
  describe("in the FSAL with the file filters of a new configuration", function () {
    let root: string;
    let notes: string;
    let fsal: FSAL;

    before(async function () {
      root = await mkdtemp(path.join(tmpdir(), "zettlr-file-types-"));
      notes = path.join(root, "Notes.MD");
      await writeFile(notes, "# Quadratic forms\n\nA form of signature (1, 9).\n");
      await writeFile(path.join(root, "lattices.md"), "# Lattices\n");
      fsal = await bootFilteredFsal(root);
    });

    after(async function () {
      await fsal.shutdown();
      await rm(root, { recursive: true, force: true });
    });

    it("lists a Markdown file whose extension is in upper case", async function () {
      const listed = (await fsal.readDirectoryRecursively(root)).paths;
      assert.deepEqual(listed.filter((listedPath) => listedPath !== root).sort(), [
        path.join(root, "Notes.MD"),
        path.join(root, "lattices.md"),
      ]);
    });

    it("reads it as a Markdown document", async function () {
      const descriptor = await fsal.getDescriptorFor(notes);
      assert.equal(descriptor.type, "file");
      assert.equal(descriptor.type === "file" ? descriptor.firstHeading : null, "Quadratic forms");
    });
  });

  describe("in the file filters", function () {
    const ROOT = "/home/user/writing";
    const filter = createIgnoreFilter({
      globalRules: [],
      workspaceRules: new Map([[ROOT, ""]]),
      showIgnored: false,
      fileTypes: { ...EVERY_FILE_TYPE, attachmentExtensions: [] },
    });

    it("lists a PDF and an image whose extension is in upper case", function () {
      assert.deepEqual(
        ["Paper.PDF", "Figure.PNG", "scan.TIF", "photo.webp", "archive.zip"].map((name) =>
          filter.hides(`${ROOT}/${name}`, false),
        ),
        [false, false, false, false, true],
      );
    });
  });
});

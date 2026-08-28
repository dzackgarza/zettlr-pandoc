/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Quote-bearing export argv red proofs (issue #1, review B2/B11)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Extends the recorder scenario of
 *                  test/export-ordered-inputs.spec.ts (whose argv contract
 *                  stays locked there) with the tokenization class review B2
 *                  names: titles and filenames containing quote characters
 *                  must arrive at the spawned `just` process as EXACTLY the
 *                  authored tokens. Under the shell:true single-quote
 *                  interpolation this cannot hold — an apostrophe inside a
 *                  filename terminates the interpolated quoting and shreds
 *                  the argv — so these specs force the exporter onto a real
 *                  argv array (shell:false; spawn still PATH-resolves, so
 *                  the same PATH-shim recorder observes the process
 *                  boundary).
 *
 *                  Also locks the B11 template sentinel: an unconfigured
 *                  LaTeX template is passed to compile-pandoc-project as ''
 *                  (the companion maps ''/'-' to its own DEFAULT_TEMPLATE),
 *                  never as a duplicated hardcoded template name.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { runRecipeExport } from "source/app/service-providers/commands/exporter/recipe-exporter";
import type { ExporterOptions } from "source/app/service-providers/commands/exporter/types";

const JUSTFILE = path.join(os.homedir(), ".pandoc", "justfile");
const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");

/** The PDF profile metadata as the exporter dispatcher passes it. */
const PDF_PROFILE = {
  name: "PDF Document.yaml",
  reader: "markdown",
  writer: "pdf",
  isInvalid: false,
};

describe("Quote-bearing export inputs (review B2/B11)", function () {
  let scratch: string;
  let binDir: string;
  let recordFile: string;
  let originalPath: string | undefined;

  before(async function () {
    scratch = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-quoted-"));
    binDir = path.join(scratch, "bin");
    recordFile = path.join(binDir, "record.bin");
    await mkdir(binDir);

    // The recording boundary of export-ordered-inputs.spec.ts: a real `just`
    // executable capturing its working directory and every argument exactly
    // as the process received them.
    const shim = path.join(binDir, "just");
    await writeFile(
      shim,
      '#!/bin/sh\n{ printf \'%s\\0\' "$PWD" "$@"; printf \'\\036\'; } >> "$(dirname "$0")/record.bin"\nexit 0\n',
    );
    await chmod(shim, 0o755);

    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  after(async function () {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async function () {
    // A fresh record stream per test: the shim APPENDS one record per spawn
    // (issue #5, C9), so a stale file would hide or inflate spawn counts.
    await rm(recordFile, { force: true });
  });

  /** The recorded { cwd, argv } of the SINGLE spawned `just` process. */
  async function recorded(): Promise<{ cwd: string; argv: string[] }> {
    const raw = await readFile(recordFile, "utf-8");
    // One RS-terminated record per spawned process: a double spawn is a
    // contract violation and must be visible, never overwritten away.
    const spawns = raw.split("\x1e");
    assert.strictEqual(spawns[spawns.length - 1], "", "the record stream is RS-terminated");
    assert.strictEqual(
      spawns.length - 1,
      1,
      "the exporter must spawn exactly ONE just process per export",
    );
    const tokens = spawns[0].split("\0");
    assert.strictEqual(tokens[tokens.length - 1], "", "the record is NUL-terminated");
    const [cwd, ...argv] = tokens.slice(0, -1);
    return { cwd, argv };
  }

  it("delivers apostrophe-bearing filenames and titles as exact single tokens", async function () {
    const projectDir = path.join(scratch, "quoted-project");
    await mkdir(projectDir);
    // A real Project whose ordered files carry the quote characters that
    // break single-quote interpolation.
    const orderedFiles = ["Halphen's Pencils.md", "Coble_Lattice_Table.md"];
    await copyFile(
      path.join(FIXTURE_ROOT, "ProjectA", "Halphen_Surfaces.md"),
      path.join(projectDir, "Halphen's Pencils.md"),
    );
    await copyFile(
      path.join(FIXTURE_ROOT, "ProjectA", "Coble_Lattice_Table.md"),
      path.join(projectDir, "Coble_Lattice_Table.md"),
    );

    await runRecipeExport(
      {
        profile: PDF_PROFILE,
        sourceFiles: orderedFiles.map((name) => ({
          path: path.join(projectDir, name),
          name,
          ext: ".md",
        })),
        targetDirectory: projectDir,
        cwd: projectDir,
        // sanitize-filename keeps apostrophes and replaces double quotes, so
        // the effective title still carries a quote character.
        defaultsOverride: { title: "Coble's Survey" },
      } as ExporterOptions,
      "notes.latex",
    );

    const { cwd, argv } = await recorded();
    assert.strictEqual(cwd, projectDir);
    assert.deepStrictEqual(
      argv,
      [
        "--justfile",
        JUSTFILE,
        "compile-pandoc-project",
        "Coble's Survey",
        "notes.latex",
        "Halphen's Pencils.md",
        "Coble_Lattice_Table.md",
      ],
      "every quote-bearing token must survive the process boundary unsplit and unmangled",
    );
  });

  it("delivers a quote-bearing single-file export title as one exact token", async function () {
    const dir = path.join(scratch, "quoted-single");
    await mkdir(dir);
    const inputFile = path.join(dir, "Enriques' Notes.md");
    await copyFile(path.join(FIXTURE_ROOT, "Standalone_Notes.md"), inputFile);

    await runRecipeExport(
      {
        profile: PDF_PROFILE,
        sourceFiles: [{ path: inputFile, name: "Enriques' Notes.md", ext: ".md" }],
        targetDirectory: dir,
      } as ExporterOptions,
      "",
    );

    const { cwd, argv } = await recorded();
    assert.strictEqual(cwd, dir);
    assert.deepStrictEqual(argv, [
      "--justfile",
      JUSTFILE,
      "compile-pandoc",
      "Enriques' Notes.md",
      "Enriques' Notes",
    ]);
  });

  it("passes the '' sentinel for an unconfigured Project template (B11)", async function () {
    const projectDir = path.join(scratch, "sentinel-project");
    await mkdir(projectDir);
    const orderedFiles = ["Theorems.md", "Halphen_Surfaces.md"];
    for (const name of orderedFiles) {
      await copyFile(path.join(FIXTURE_ROOT, "ProjectA", name), path.join(projectDir, name));
    }

    await runRecipeExport(
      {
        profile: PDF_PROFILE,
        sourceFiles: orderedFiles.map((name) => ({
          path: path.join(projectDir, name),
          name,
          ext: ".md",
        })),
        targetDirectory: projectDir,
        cwd: projectDir,
        defaultsOverride: { title: "Sentinel Notes" },
      } as ExporterOptions,
      "",
    );

    const { argv } = await recorded();
    assert.deepStrictEqual(argv, [
      "--justfile",
      JUSTFILE,
      "compile-pandoc-project",
      "Sentinel Notes",
      // The companion owns its default template: ''/'-' resolve to its
      // DEFAULT_TEMPLATE (pandoc-config aebbc61). The app never duplicates
      // the template name.
      "",
      "Theorems.md",
      "Halphen_Surfaces.md",
    ]);
  });
});

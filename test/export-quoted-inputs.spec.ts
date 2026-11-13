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
import { copyFile, mkdir, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { runRecipeExport } from "source/app/service-providers/commands/exporter/recipe-exporter";
import type { ExporterOptions } from "source/app/service-providers/commands/exporter/types";
import { parse as parseDirectory } from "source/app/service-providers/fsal/fsal-directory";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { installRecordingJust, type RecordingJust } from "./recording-just";

/** The folders of the inputs, read from disk as the FSAL reads them. */
const FOLDERS = {
  getAnyDirectoryDescriptor: async (dirPath: string) => await parseDirectory(dirPath),
};

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
  let just: RecordingJust;

  before(async function () {
    scratch = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-quoted-"));
    just = await installRecordingJust();
  });

  after(async function () {
    await just.remove();
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async function () {
    await just.forget();
  });

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
          textFile: path.join(projectDir, name),
        })),
        targetDirectory: projectDir,
        cwd: projectDir,
        // sanitize-filename keeps apostrophes and replaces double quotes, so
        // the effective title still carries a quote character.
        defaultsOverride: { title: "Coble's Survey" },
      } as ExporterOptions,
      {
        latexTemplate: "notes.latex",
        wikilinks: { index: new WikilinkIndex([]), linkFormat: "link|title" },
        fsal: FOLDERS,
        mainLibrary: "",
      },
    );

    const { cwd, argv } = await just.onlyRun();
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
        sourceFiles: [
          { path: inputFile, name: "Enriques' Notes.md", ext: ".md", textFile: inputFile },
        ],
        targetDirectory: dir,
      } as ExporterOptions,
      {
        latexTemplate: "",
        wikilinks: { index: new WikilinkIndex([]), linkFormat: "link|title" },
        fsal: FOLDERS,
        mainLibrary: "",
      },
    );

    const { cwd, argv } = await just.onlyRun();
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
          textFile: path.join(projectDir, name),
        })),
        targetDirectory: projectDir,
        cwd: projectDir,
        defaultsOverride: { title: "Sentinel Notes" },
      } as ExporterOptions,
      {
        latexTemplate: "",
        wikilinks: { index: new WikilinkIndex([]), linkFormat: "link|title" },
        fsal: FOLDERS,
        mainLibrary: "",
      },
    );

    const { argv } = await just.onlyRun();
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

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ordered Project export input red proofs (issue #1 Phase 7)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the argv contract of the recipe exporter at the
 *                  real process boundary:
 *
 *                  - A single-file export keeps today's recipe invocation
 *                    byte-for-byte: `--justfile ~/.pandoc/justfile
 *                    compile-pandoc <sourceBase> <title>`, run in the source
 *                    file's directory.
 *                  - A Project export (multiple ordered sourceFiles, as
 *                    dir-project-export.ts builds them from
 *                    ProjectSettings.files) invokes the companion
 *                    `compile-pandoc-project <title> <template>
 *                    <files...>` recipe (pandoc-config#5) with the files in
 *                    ProjectSettings order, project-relative, run in the
 *                    Project root (options.cwd).
 *                  - A filename containing spaces arrives at the spawned
 *                    process as ONE argument.
 *
 *                  Seam: runShellCommand spawns through the shell with PATH
 *                  resolution, so a scratch `just` executable prepended to
 *                  PATH receives the REAL post-shell argv and records it
 *                  (the same real-subprocess style as export-scripts.spec.ts,
 *                  where the invoked script asserts what it received). No
 *                  app code is stubbed; the recorded tokens are exactly what
 *                  the real recipe would see.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { copyFile, mkdir, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { runRecipeExport } from "source/app/service-providers/commands/exporter/recipe-exporter";
import type { ExporterOptions } from "source/app/service-providers/commands/exporter/types";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { installRecordingJust, type RecordingJust } from "./recording-just";

const JUSTFILE = path.join(os.homedir(), ".pandoc", "justfile");
const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");

/** The PDF profile metadata as the exporter dispatcher passes it. */
const PDF_PROFILE = {
  name: "PDF Document.yaml",
  reader: "markdown",
  writer: "pdf",
  isInvalid: false,
};

describe("Ordered Project export inputs (issue #1 Phase 7)", function () {
  let scratch: string;
  let just: RecordingJust;

  before(async function () {
    scratch = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-ordered-"));
    just = await installRecordingJust();
  });

  after(async function () {
    await just.remove();
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async function () {
    await just.forget();
  });

  it("keeps the single-file export invocation unchanged", async function () {
    const dir = path.join(scratch, "single");
    await mkdir(dir);
    const inputFile = path.join(dir, "input.md");
    await copyFile(path.join(FIXTURE_ROOT, "Standalone_Notes.md"), inputFile);

    await runRecipeExport(
      {
        profile: PDF_PROFILE,
        sourceFiles: [{ path: inputFile, name: "input.md", ext: ".md" }],
        targetDirectory: dir,
      } as ExporterOptions,
      "",
      new WikilinkIndex([]),
    );

    const { cwd, argv } = await just.onlyRun();
    assert.strictEqual(cwd, dir);
    assert.deepStrictEqual(argv, ["--justfile", JUSTFILE, "compile-pandoc", "input.md", "input"]);
  });

  it("passes ordered Project inputs to compile-pandoc-project", async function () {
    // A real three-file Project, built exactly as dir-project-export.ts
    // does: ProjectSettings.files (ordered, project-relative) mapped to
    // absolute sourceFiles. The order is deliberately non-alphabetical.
    const projectDir = path.join(scratch, "project");
    await mkdir(projectDir);
    const orderedFiles = ["Theorems.md", "Coble_Lattice_Table.md", "Halphen_Surfaces.md"];
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
        defaultsOverride: { title: "Lattice Notes" },
      } as ExporterOptions,
      "lattice-notes.latex",
      new WikilinkIndex([]),
    );

    const { cwd, argv } = await just.onlyRun();
    assert.strictEqual(cwd, projectDir, "a Project export runs in the Project root");
    assert.deepStrictEqual(argv, [
      "--justfile",
      JUSTFILE,
      "compile-pandoc-project",
      "Lattice Notes",
      "lattice-notes.latex",
      "Theorems.md",
      "Coble_Lattice_Table.md",
      "Halphen_Surfaces.md",
    ]);
  });

  it("delivers a spaced filename as exactly one argument", async function () {
    const projectDir = path.join(scratch, "spaced");
    await mkdir(projectDir);
    const orderedFiles = ["Intro.md", "Spaced Section Name.md"];
    await copyFile(
      path.join(FIXTURE_ROOT, "ProjectA", "Theorems.md"),
      path.join(projectDir, "Intro.md"),
    );
    await copyFile(
      path.join(FIXTURE_ROOT, "ProjectA", "Halphen_Surfaces.md"),
      path.join(projectDir, "Spaced Section Name.md"),
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
        defaultsOverride: { title: "Spaced Title" },
      } as ExporterOptions,
      "notes.latex",
      new WikilinkIndex([]),
    );

    const { argv } = await just.onlyRun();
    assert.deepStrictEqual(argv, [
      "--justfile",
      JUSTFILE,
      "compile-pandoc-project",
      "Spaced Title",
      "notes.latex",
      "Intro.md",
      "Spaced Section Name.md",
    ]);
    // The decisive spacing claim, independent of the full shape: the spaced
    // name survives the shell as ONE token, never split.
    assert.strictEqual(argv.filter((token) => token === "Spaced Section Name.md").length, 1);
  });
});

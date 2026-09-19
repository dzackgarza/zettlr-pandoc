import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  __resetTexResourceResolverCacheForTests,
  resolveTexResources,
} from "source/app/util/tex-resource-resolver";

describe("TeX resource resolver", function () {
  beforeEach(function () {
    __resetTexResourceResolverCacheForTests();
  });

  it("mirrors source, Project, canonical ~/.pandoc, graphicspath, and TEXINPUTS roots", async function () {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "zettlr-tex-resources-"));
    const home = path.join(scratch, "home");
    const project = path.join(scratch, "project");
    const sourceDir = path.join(project, "chapters");
    const customInputs = path.join(scratch, "custom-inputs");
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(path.join(project, "figs"), { recursive: true }),
      mkdir(path.join(home, ".pandoc", "styles", "macros", "nested"), { recursive: true }),
      mkdir(path.join(home, ".pandoc", "figures", "tikz"), { recursive: true }),
      mkdir(path.join(customInputs, "deep"), { recursive: true }),
    ]);
    const sourcePath = path.join(sourceDir, "paper.md");
    await Promise.all([
      writeFile(sourcePath, "Text.\n"),
      writeFile(path.join(sourceDir, "local.tex"), "local\n"),
      writeFile(path.join(project, "figs", "project.pdf"), "%PDF"),
      writeFile(
        path.join(home, ".pandoc", "styles", "macros", "nested", "compiler-only.tex"),
        "macro\n",
      ),
      writeFile(path.join(home, ".pandoc", "figures", "tikz", "cusp.tikz"), "figure\n"),
      writeFile(path.join(customInputs, "deep", "custom.tex"), "custom\n"),
    ]);

    const result = await resolveTexResources(
      {
        sourcePath,
        projectRoots: [project],
        graphicRoots: ["../figs"],
        resources: [
          { id: 1, kind: "input", path: "local" },
          { id: 2, kind: "graphics", path: "project" },
          { id: 3, kind: "input", path: "compiler-only" },
          { id: 4, kind: "input", path: "tikz/cusp.tikz" },
          { id: 5, kind: "input", path: "custom" },
          { id: 6, kind: "input", path: "missing/path.tex" },
          { id: 7, kind: "input", path: "\\dynamicMacro" },
        ],
      },
      home,
      { TEXINPUTS: `${customInputs}//` },
    );

    for (const id of [1, 2, 3, 4, 5]) {
      const resolvedPath = result.find((entry) => entry.id === id)?.resolvedPath;
      assert.ok(
        resolvedPath !== undefined && resolvedPath !== "",
        `resource ${String(id)} should resolve`,
      );
    }
    assert.deepStrictEqual(
      result.find((entry) => entry.id === 6),
      { id: 6, checkable: true },
    );
    assert.deepStrictEqual(
      result.find((entry) => entry.id === 7),
      { id: 7, checkable: false },
    );
  });
});

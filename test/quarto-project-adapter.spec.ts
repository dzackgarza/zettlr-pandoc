import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import { loadDatabase } from "source/app/service-providers/citeproc/util/database-loader";
import { parse as parseDirectory } from "source/app/service-providers/fsal/fsal-directory";
import { parseQuartoProject } from "source/app/util/quarto-project";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { getBibliographyForDescriptor } from "source/common/util/get-bibliography-for-descriptor";
import type { MDFileDescriptor } from "source/types/common/fsal";
import { buildQuartoBookOutline } from "source/win-main/file-manager/quarto-book-outline";

const ROOT = path.resolve("test", "fixtures", "quarto-book");

describe("Quarto project adapter", function () {
  const project = parseQuartoProject(ROOT, readFileSync(path.join(ROOT, "_quarto.yml"), "utf8"));

  it("projects the authored book structure into ordered navigation", function () {
    assert.deepStrictEqual(project.navigation, [
      { kind: "chapter", path: "index.md" },
      {
        kind: "part",
        title: "Foundations",
        chapters: ["foundations/categories.md", "foundations/forms.md"],
      },
      {
        kind: "part",
        title: "Computation",
        chapters: ["computation/sage.md"],
      },
    ]);
    assert.deepStrictEqual(project.files, [
      "index.md",
      "foundations/categories.md",
      "foundations/forms.md",
      "computation/sage.md",
    ]);
  });

  it("builds a visible book hierarchy with ordered chapter actions", function () {
    const titles = new Map<string, string>([
      [path.join(ROOT, "index.md"), "Lattice Notes"],
      [path.join(ROOT, "foundations", "categories.md"), "Categories"],
      [path.join(ROOT, "foundations", "forms.md"), "Forms"],
      [path.join(ROOT, "computation", "sage.md"), "Sage"],
    ]);

    assert.deepStrictEqual(
      buildQuartoBookOutline(ROOT, project.navigation, (filePath) => {
        const title = titles.get(filePath);
        if (title === undefined) {
          throw new Error(`Missing title for ${filePath}`);
        }
        return title;
      }),
      {
        items: [
          {
            kind: "chapter",
            path: path.join(ROOT, "index.md"),
            title: "Lattice Notes",
            position: 1,
          },
          {
            kind: "part",
            title: "Foundations",
            chapters: [
              {
                path: path.join(ROOT, "foundations", "categories.md"),
                title: "Categories",
                position: 2,
              },
              { path: path.join(ROOT, "foundations", "forms.md"), title: "Forms", position: 3 },
            ],
          },
          {
            kind: "part",
            title: "Computation",
            chapters: [
              { path: path.join(ROOT, "computation", "sage.md"), title: "Sage", position: 4 },
            ],
          },
        ],
        orderedPaths: [
          path.join(ROOT, "index.md"),
          path.join(ROOT, "foundations", "categories.md"),
          path.join(ROOT, "foundations", "forms.md"),
          path.join(ROOT, "computation", "sage.md"),
        ],
      },
    );
  });

  it("resolves every inherited bibliography from the manifest root", function () {
    assert.deepStrictEqual(project.bibliographies, [
      path.resolve(ROOT, "references.bib"),
      path.resolve(ROOT, "web.bib"),
    ]);
  });

  it("projects the manifest through the real FSAL directory boundary", async function () {
    const descriptor = await parseDirectory(ROOT);

    assert.deepStrictEqual(descriptor.settings.project, {
      manifest: {
        kind: "quarto",
        path: path.resolve(ROOT, "_quarto.yml"),
        bibliographies: [path.resolve(ROOT, "references.bib"), path.resolve(ROOT, "web.bib")],
        navigation: project.navigation,
      },
      title: "Lattice Notes",
      profiles: [],
      files: project.files,
      cslStyle: "",
      templates: { tex: "", html: "" },
    });
  });

  it("loads citations from every bibliography inherited through FSAL", async function () {
    const projectRoot = await parseDirectory(ROOT);
    const descriptor = {
      path: path.join(ROOT, "index.md"),
      frontmatter: null,
    } as MDFileDescriptor;
    const databases = getBibliographyForDescriptor(descriptor, projectRoot.settings.project);

    assert.deepStrictEqual(databases, [
      path.join(ROOT, "references.bib"),
      path.join(ROOT, "web.bib"),
    ]);
    assert.deepStrictEqual(
      await Promise.all(
        databases.map(async (database) => Object.keys((await loadDatabase(database)).cslData)),
      ),
      [["Mac98"], ["Stacks"]],
    );
  });

  it("indexes Quarto definitions and occurrences through the workspace model", function () {
    const definitionPath = path.join(ROOT, "foundations", "categories.md");
    const occurrencePath = path.join(ROOT, "index.md");
    const definition = extractReferences(definitionPath, readFileSync(definitionPath, "utf8"));
    const occurrence = extractReferences(occurrencePath, readFileSync(occurrencePath, "utf8"));

    assert.deepStrictEqual(
      definition.definitions.map((entry) => ({
        key: entry.key,
        family: entry.family,
        title: entry.title,
      })),
      [{ key: "def-core", family: "def", title: undefined }],
    );
    assert.deepStrictEqual(
      occurrence.occurrences.map((entry) => ({ key: entry.key, family: entry.family })),
      [{ key: "def-core", family: "def" }],
    );
  });
});

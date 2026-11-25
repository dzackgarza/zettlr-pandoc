/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The resolved form of an export
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     `resolveExport` says what an export item runs: the filter
 *                  chain in its order, the template and the citation style
 *                  with the place that each comes from, who gives the math,
 *                  and each stage. A window shows this record and the log
 *                  keeps it; the defaults writer of an export decides with
 *                  the same functions (`test/export-filters.spec.ts`).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import {
  describeResolvedExport,
  type ExportSettings,
  projectOverride,
  resolveExport,
} from "source/app/service-providers/commands/exporter/resolve-export";
import { exportItem } from "./export-item-fixtures";

const PANDOC_DIRECTORY = "/home/author/.pandoc";
const WIKILINK_FILTER = `${PANDOC_DIRECTORY}/filters/wikilinks.lua`;
const HTML = { name: "HTML.yaml", reader: "markdown", writer: "html" };
const LATEX = { name: "LaTeX.yaml", reader: "markdown", writer: "latex" };
const NO_OVERRIDE = { template: undefined, csl: undefined };

const SETTINGS: ExportSettings = {
  filters: ["amsthm.lua", "/filters/own.lua"],
  htmlTemplate: "",
  latexTemplate: "",
  cslStyle: "",
  cslLibrary: "",
};

describe("The resolved form of an export", function () {
  it("gives the filter chain of a Pandoc item in the order that Pandoc runs it", function () {
    const resolved = resolveExport(
      exportItem("HTML.yaml", [HTML]),
      {
        filters: [{ type: "citeproc" }, { type: "lua", path: "numbering.lua" }],
        template: undefined,
      },
      SETTINGS,
      NO_OVERRIDE,
      PANDOC_DIRECTORY,
      WIKILINK_FILTER,
    );

    assert.equal(resolved.stages.length, 1);
    const [stage] = resolved.stages;
    assert.ok(stage.kind === "pandoc");
    assert.deepEqual(stage.filters, [
      WIKILINK_FILTER,
      "amsthm.lua",
      "/filters/own.lua",
      "citeproc",
      "numbering.lua",
    ]);
  });

  it("takes the template of the Project, then of the defaults file, then of the settings", function () {
    const item = exportItem("HTML.yaml", [HTML]);
    const settings = { ...SETTINGS, htmlTemplate: "settings.html", latexTemplate: "settings.tex" };
    const templateOf = (
      declared: string | undefined,
      override: string | undefined,
      withSettings: ExportSettings,
    ): unknown => {
      const [stage] = resolveExport(
        item,
        { filters: [], template: declared },
        withSettings,
        { template: override, csl: undefined },
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;
      assert.ok(stage.kind === "pandoc");
      return stage.template;
    };

    assert.deepEqual(templateOf("file.html", "project.html", settings), {
      value: "project.html",
      from: "export",
    });
    assert.deepEqual(templateOf("file.html", undefined, settings), {
      value: "file.html",
      from: "defaults-file",
    });
    assert.deepEqual(templateOf(undefined, undefined, settings), {
      value: "settings.html",
      from: "settings",
    });
    assert.deepEqual(
      templateOf(undefined, undefined, SETTINGS),
      { value: "pandoc_preview_template.html", from: "pandoc-directory" },
      "without a template the export uses the template of ~/.pandoc for the writer",
    );
  });

  it("takes the citation style of the Project before the style of the settings", function () {
    const item = exportItem("HTML.yaml", [HTML]);
    const styleOf = (override: string | undefined): unknown => {
      const [stage] = resolveExport(
        item,
        { filters: [], template: undefined },
        { ...SETTINGS, cslStyle: "/styles/settings.csl", cslLibrary: "/library.bib" },
        { template: undefined, csl: override },
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;
      assert.ok(stage.kind === "pandoc");
      assert.equal(stage.citationLibrary, "/library.bib");
      return stage.citationStyle;
    };

    assert.deepEqual(styleOf("/styles/project.csl"), {
      value: "/styles/project.csl",
      from: "export",
    });
    assert.deepEqual(styleOf(undefined), { value: "/styles/settings.csl", from: "settings" });
  });

  it("uses the template of ~/.pandoc for the writer when no template is set", function () {
    const templateOfWriter = (writer: string): unknown => {
      const name = `${writer}.yaml`;
      const [stage] = resolveExport(
        exportItem(name, [{ name, reader: "markdown", writer }]),
        { filters: [], template: undefined },
        SETTINGS,
        NO_OVERRIDE,
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;
      assert.ok(stage.kind === "pandoc");
      return stage.template;
    };

    assert.deepEqual(templateOfWriter("html"), {
      value: "pandoc_preview_template.html",
      from: "pandoc-directory",
    });
    assert.deepEqual(templateOfWriter("revealjs"), {
      value: "pandoc_revealjs_template.html",
      from: "pandoc-directory",
    });
    assert.deepEqual(templateOfWriter("latex"), {
      value: "research_draft.tex",
      from: "pandoc-directory",
    });
    assert.deepEqual(templateOfWriter("beamer"), {
      value: "research_beamer.tex",
      from: "pandoc-directory",
    });
    assert.deepEqual(templateOfWriter("context"), {
      value: "pandoc_context_template.tex",
      from: "pandoc-directory",
    });
    // A writer without a template in ~/.pandoc gets the template of Pandoc.
    assert.equal(templateOfWriter("docx"), undefined);
  });

  it("names who gives a Pandoc export its math", function () {
    const mathOfWriter = (writer: string): unknown => {
      const name = `${writer}.yaml`;
      const [stage] = resolveExport(
        exportItem(name, [{ name, reader: "markdown", writer }]),
        { filters: [], template: undefined },
        SETTINGS,
        NO_OVERRIDE,
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;
      assert.ok(stage.kind === "pandoc");
      return stage.math;
    };

    // The template owns the math of an HTML page and of a TeX document.
    assert.deepEqual(mathOfWriter("html"), {
      owner: "template",
      pandocDirectory: PANDOC_DIRECTORY,
    });
    assert.deepEqual(mathOfWriter("revealjs"), {
      owner: "template",
      pandocDirectory: PANDOC_DIRECTORY,
    });
    assert.deepEqual(mathOfWriter("latex"), {
      owner: "template",
      pandocDirectory: PANDOC_DIRECTORY,
    });
    // Each other writer gets the macros from the first input of the export.
    for (const writer of ["docx", "odt", "epub3", "jats", "context", "gfm+raw_html", "plain"]) {
      assert.deepEqual(mathOfWriter(writer), {
        owner: "macro-input",
        pandocDirectory: PANDOC_DIRECTORY,
        input: `${PANDOC_DIRECTORY}/templates/css/math-macros.md`,
      });
    }
  });

  it("puts the filters of the macro input into the filter chain of a writer whose template does not own the math", function () {
    const filtersOfWriter = (writer: string): string[] => {
      const name = `${writer}.yaml`;
      const [stage] = resolveExport(
        exportItem(name, [{ name, reader: "markdown", writer }]),
        { filters: [{ type: "citeproc" }], template: undefined },
        SETTINGS,
        NO_OVERRIDE,
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;
      assert.ok(stage.kind === "pandoc");
      return stage.filters;
    };

    // The definitions leave the document before each other filter reads it.
    assert.deepEqual(filtersOfWriter("docx"), [
      WIKILINK_FILTER,
      "amsthm.lua",
      "/filters/own.lua",
      `${PANDOC_DIRECTORY}/filters/math-macros.lua`,
      "citeproc",
    ]);
    // ConTeXt gets each formula as MathML after each other filter.
    assert.deepEqual(filtersOfWriter("context"), [
      WIKILINK_FILTER,
      "amsthm.lua",
      "/filters/own.lua",
      `${PANDOC_DIRECTORY}/filters/math-macros.lua`,
      "citeproc",
      `${PANDOC_DIRECTORY}/filters/context-mathml.lua`,
    ]);
    // A template that owns the math has no macro input.
    assert.deepEqual(filtersOfWriter("html"), [
      WIKILINK_FILTER,
      "amsthm.lua",
      "/filters/own.lua",
      "citeproc",
    ]);
  });

  it("puts the command of an item after its Pandoc stage", function () {
    const item = exportItem(
      "Handout",
      [LATEX],
      [{ name: "Handout", base: "LaTeX.yaml", command: "make-handout", extension: "pdf" }],
    );

    const resolved = resolveExport(
      item,
      { filters: [], template: undefined },
      SETTINGS,
      NO_OVERRIDE,
      PANDOC_DIRECTORY,
      WIKILINK_FILTER,
    );

    assert.deepEqual(
      resolved.stages.map((stage) => stage.kind),
      ["pandoc", "command"],
    );
    assert.deepEqual(resolved.stages[1], {
      kind: "command",
      command: "make-handout",
      runsOn: "pandoc-output",
      extension: "pdf",
    });
  });

  it("gives the recipe the template of the Project, then the LaTeX template of the settings", function () {
    const item = exportItem("PDF.yaml");
    const stageOf = (override: string | undefined, latexTemplate: string): unknown =>
      resolveExport(
        item,
        undefined,
        { ...SETTINGS, latexTemplate },
        { template: override, csl: undefined },
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;

    assert.deepEqual(stageOf("project.tex", "settings.tex"), [
      {
        kind: "recipe",
        recipe: "compile-pandoc",
        template: { value: "project.tex", from: "export" },
        citationLibrary: undefined,
      },
    ]);
    assert.deepEqual(stageOf(undefined, "settings.tex"), [
      {
        kind: "recipe",
        recipe: "compile-pandoc",
        template: { value: "settings.tex", from: "settings" },
        citationLibrary: undefined,
      },
    ]);
    assert.deepEqual(stageOf(undefined, ""), [
      { kind: "recipe", recipe: "compile-pandoc", template: undefined, citationLibrary: undefined },
    ]);
  });

  it("resolves a command and a bundle to their one stage", function () {
    const upload = exportItem(
      "Upload",
      [],
      [{ name: "Upload", base: "", command: "upload-notes", extension: "" }],
    );

    assert.deepEqual(
      resolveExport(upload, undefined, SETTINGS, NO_OVERRIDE, PANDOC_DIRECTORY, WIKILINK_FILTER),
      {
        item: "Upload",
        origin: "settings",
        stages: [{ kind: "command", command: "upload-notes", runsOn: "document", extension: "" }],
      },
    );
    assert.deepEqual(
      resolveExport(
        exportItem("Textpack.yaml"),
        undefined,
        SETTINGS,
        NO_OVERRIDE,
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages,
      [{ kind: "bundle", format: "textpack" }],
    );
  });

  it("says in one line each what a window shows of an export", function () {
    const item = exportItem(
      "Handout",
      [LATEX],
      [{ name: "Handout", base: "LaTeX.yaml", command: "make-handout", extension: "pdf" }],
    );
    const resolved = resolveExport(
      item,
      { filters: ["citeproc"], template: "research_draft.tex" },
      { ...SETTINGS, cslStyle: "/styles/ams.csl" },
      NO_OVERRIDE,
      PANDOC_DIRECTORY,
      WIKILINK_FILTER,
    );

    assert.deepEqual(describeResolvedExport(resolved), [
      "Pandoc markdown → latex (LaTeX.yaml)",
      "filters: wikilinks.lua › amsthm.lua › own.lua › citeproc",
      "template: research_draft.tex (defaults file)",
      "citation style: ams.csl (settings)",
      "math: the template",
      "then make-handout → .pdf",
    ]);
    assert.deepEqual(
      describeResolvedExport(
        resolveExport(
          exportItem("PDF.yaml"),
          undefined,
          SETTINGS,
          { template: "book.tex", csl: undefined },
          PANDOC_DIRECTORY,
          WIKILINK_FILTER,
        ),
      ),
      [
        "recipe compile-pandoc of ~/.pandoc (its filters, its flags)",
        "template: book.tex (Project)",
      ],
    );
    const word = { name: "Word.yaml", reader: "markdown", writer: "docx" };
    assert.deepEqual(
      describeResolvedExport(
        resolveExport(
          exportItem("Word.yaml", [word]),
          { filters: [], template: undefined },
          SETTINGS,
          NO_OVERRIDE,
          PANDOC_DIRECTORY,
          WIKILINK_FILTER,
        ),
      ).filter((line) => line.startsWith("math:")),
      ["math: the macros of math-macros.md (~/.pandoc), the first input"],
    );
  });

  it("gives a Project its LaTeX template for TeX and the recipe, and its HTML template for HTML", function () {
    const project = { templates: { tex: "book.tex", html: "book.html" }, cslStyle: "/book.csl" };

    assert.deepEqual(projectOverride(exportItem("PDF.yaml"), project), {
      template: "book.tex",
      csl: "/book.csl",
    });
    assert.deepEqual(projectOverride(exportItem("LaTeX.yaml", [LATEX]), project), {
      template: "book.tex",
      csl: "/book.csl",
    });
    assert.deepEqual(projectOverride(exportItem("HTML.yaml", [HTML]), project), {
      template: "book.html",
      csl: "/book.csl",
    });
    assert.deepEqual(projectOverride(exportItem("Textbundle.yaml"), { ...project, cslStyle: "" }), {
      template: undefined,
      csl: undefined,
    });
  });
});

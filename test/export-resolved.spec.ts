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
  injectMathHeaders: true,
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
    assert.equal(
      templateOf(undefined, undefined, SETTINGS),
      undefined,
      "without a template Pandoc uses its own for the writer",
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

  it("names who gives a Pandoc export its math", function () {
    const item = exportItem("HTML.yaml", [HTML]);
    const mathOf = (injectMathHeaders: boolean): unknown => {
      const [stage] = resolveExport(
        item,
        { filters: [], template: undefined },
        { ...SETTINGS, injectMathHeaders },
        NO_OVERRIDE,
        PANDOC_DIRECTORY,
        WIKILINK_FILTER,
      ).stages;
      assert.ok(stage.kind === "pandoc");
      return stage.math;
    };

    assert.deepEqual(mathOf(true), { owner: "application", pandocDirectory: PANDOC_DIRECTORY });
    assert.deepEqual(mathOf(false), { owner: "template", pandocDirectory: PANDOC_DIRECTORY });

    // The headers of the application are for HTML and for TeX: a Word
    // document gets what Pandoc makes of the math.
    const [word] = resolveExport(
      exportItem("Word.yaml", [{ name: "Word.yaml", reader: "markdown", writer: "docx" }]),
      { filters: [], template: undefined },
      SETTINGS,
      NO_OVERRIDE,
      PANDOC_DIRECTORY,
      WIKILINK_FILTER,
    ).stages;
    assert.ok(word.kind === "pandoc");
    assert.equal(word.math.owner, "pandoc");
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
      `math: headers of the application, macros of ${PANDOC_DIRECTORY}`,
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

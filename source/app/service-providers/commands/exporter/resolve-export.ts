/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The resolved form of an export
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     What an export runs is decided in more than one place: the
 *                  defaults file of the item, the settings, the Project, and
 *                  the recipe of ~/.pandoc. The functions here decide the
 *                  effective filter chain, the effective template and the
 *                  effective citation style. The defaults writer of the
 *                  export calls them, and `resolveExport` puts the same
 *                  decisions into one record that a window shows and that
 *                  the log keeps: what a window shows is what runs.
 *
 * END HEADER
 */

import { isHtmlWriter, isTexWriter } from "@common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "@common/pandoc-util/parse-reader-writer";
import type { ExportItem, ExportItemOrigin } from "./export-items";

/** A value of an export, and where the export takes it from. */
export interface Sourced {
  value: string;
  /**
   * `export`: the export itself (the template or the style of a Project).
   * `defaults-file`: the defaults file of the item. `settings`: the
   * settings of the application.
   */
  from: "export" | "defaults-file" | "settings";
}

/** The settings that decide what an export runs. */
export interface ExportSettings {
  /** The filters of `export.filters`, in their order */
  filters: string[];
  htmlTemplate: string;
  latexTemplate: string;
  cslStyle: string;
  cslLibrary: string;
  /** Whether the application adds its math headers to a Pandoc export */
  injectMathHeaders: boolean;
}

/** What one export sets in the place of the settings (a Project). */
export interface ExportOverride {
  template: string | undefined;
  csl: string | undefined;
}

/**
 * The filters that each Pandoc export runs before the filters of its
 * defaults file: the wikilink filter of ~/.pandoc, which runs before each
 * other filter, and the filters of the settings in their order.
 */
export function leadingFilters(wikilinkFilter: string, settingsFilters: string[]): string[] {
  return [wikilinkFilter, ...settingsFilters];
}

/**
 * The filter chain of a Pandoc export, in the order that Pandoc runs it: the
 * leading filters, then the filters of the defaults file.
 */
export function effectiveFilters<Entry>(
  leading: string[],
  defaultsFilters: Entry[],
): Array<string | Entry> {
  return [...leading, ...defaultsFilters];
}

/**
 * The name of one filter of a defaults file. Pandoc takes a filter as a
 * path or a name, or as a mapping with its `path` and its `type`.
 */
export function filterName(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry instanceof Object && "path" in entry && typeof entry.path === "string") {
    return entry.path;
  }
  // A mapping without a path names a filter that Pandoc has itself
  // (`type: citeproc`).
  if (entry instanceof Object && "type" in entry && typeof entry.type === "string") {
    return entry.type;
  }
  return JSON.stringify(entry);
}

/**
 * The template of a Pandoc export. The template of the export (a Project)
 * goes first, then the template of the defaults file, then the template of
 * the settings for the family of the writer. Without any of them Pandoc
 * uses its own template for the writer.
 */
export function effectiveTemplate(
  writer: string,
  defaultsTemplate: string | undefined,
  override: ExportOverride,
  settings: Pick<ExportSettings, "htmlTemplate" | "latexTemplate">,
): Sourced | undefined {
  if (override.template !== undefined && override.template !== "") {
    return { value: override.template, from: "export" };
  }
  if (defaultsTemplate !== undefined && defaultsTemplate !== "") {
    return { value: defaultsTemplate, from: "defaults-file" };
  }
  const writerName = parseReaderWriter(writer).name;
  if (isHtmlWriter(writerName) && settings.htmlTemplate !== "") {
    return { value: settings.htmlTemplate, from: "settings" };
  }
  if (isTexWriter(writerName) && settings.latexTemplate !== "") {
    return { value: settings.latexTemplate, from: "settings" };
  }
  return undefined;
}

/**
 * The citation style of a Pandoc export: the style of the export (a
 * Project) goes before the style of the settings. An empty style is none.
 */
export function effectiveCitationStyle(
  override: ExportOverride,
  settings: Pick<ExportSettings, "cslStyle">,
): Sourced | undefined {
  if (override.csl !== undefined) {
    return override.csl === "" ? undefined : { value: override.csl, from: "export" };
  }
  return settings.cslStyle === "" ? undefined : { value: settings.cslStyle, from: "settings" };
}

/** The settings of a Project that an export of the Project takes in the place of the settings. */
export interface ProjectExportSettings {
  templates: { tex: string; html: string };
  /** The citation style of the Project; empty for the style of the settings */
  cslStyle: string;
}

/**
 * What an export of a Project sets itself for an item. The LaTeX template
 * of the Project is for each item that goes through TeX: the TeX writers of
 * Pandoc and the PDF recipe. The HTML template is for the HTML writers of
 * Pandoc. These are the families of the settings `export.latexTemplate` and
 * `export.htmlTemplate`.
 */
export function projectOverride(item: ExportItem, project: ProjectExportSettings): ExportOverride {
  const { engine } = item;
  const csl = project.cslStyle === "" ? undefined : project.cslStyle;
  const goesThroughTex =
    engine.kind === "recipe" ||
    (engine.kind === "pandoc" && isTexWriter(parseReaderWriter(engine.writer).name));
  if (goesThroughTex && project.templates.tex !== "") {
    return { template: project.templates.tex, csl };
  }
  if (
    engine.kind === "pandoc" &&
    isHtmlWriter(parseReaderWriter(engine.writer).name) &&
    project.templates.html !== ""
  ) {
    return { template: project.templates.html, csl };
  }
  return { template: undefined, csl };
}

/**
 * Who gives a Pandoc export with this writer its math. The headers of the
 * application are for the HTML writers and the TeX writers
 * (`injectPandocMathHeaders`).
 */
export function mathOwner(
  writer: string,
  settings: Pick<ExportSettings, "injectMathHeaders">,
): "application" | "template" | "pandoc" {
  const writerName = parseReaderWriter(writer).name;
  if (!isHtmlWriter(writerName) && !isTexWriter(writerName)) {
    return "pandoc";
  }
  return settings.injectMathHeaders ? "application" : "template";
}

/** What the defaults file of a Pandoc engine declares, as far as an export decides with it. */
export interface DeclaredDefaults {
  /** The filters as the file declares them (`filterName`) */
  filters: unknown[];
  template: string | undefined;
}

/** The Pandoc stage of an export, resolved. */
export interface ResolvedPandocStage {
  kind: "pandoc";
  defaultsFile: string;
  reader: string;
  writer: string;
  /** The filter chain in the order that Pandoc runs it */
  filters: string[];
  /** The template, or undefined for the template of Pandoc for the writer */
  template: Sourced | undefined;
  citationStyle: Sourced | undefined;
  /** The library of the settings, or undefined */
  citationLibrary: string | undefined;
  /**
   * Who gives the export its math. The application adds its headers, with
   * the macros of the Pandoc directory, to an HTML writer and to a TeX
   * writer when the setting is on; with the setting off the template owns
   * the math of those writers. Each other writer gets what Pandoc makes of
   * the math itself.
   */
  math: { owner: "application" | "template" | "pandoc"; pandocDirectory: string };
}

/** One stage of an export, in the order that the stages run. */
export type ResolvedStage =
  | ResolvedPandocStage
  /** The PDF recipe: it owns the filters and each flag of the PDF. */
  | {
      kind: "recipe";
      recipe: string;
      /** The template that the recipe gets, or undefined for its own default */
      template: Sourced | undefined;
      /** The library of the settings; the recipe adds the bibliography of the documents */
      citationLibrary: string | undefined;
    }
  | { kind: "bundle"; format: string }
  /** A command, on the document (or the folder of a Project) or on the file of Pandoc */
  | { kind: "command"; command: string; runsOn: "document" | "pandoc-output"; extension: string };

/** What an export item runs, with each decision made. */
export interface ResolvedExport {
  item: string;
  origin: ExportItemOrigin;
  stages: ResolvedStage[];
}

/**
 * Resolves an export item into the stages that it runs.
 *
 * @param   {ExportItem}                  item             The item
 * @param   {DeclaredDefaults|undefined}  declared         What the defaults file of a
 *                                                         Pandoc engine declares;
 *                                                         undefined for another engine
 * @param   {ExportSettings}              settings         The settings
 * @param   {ExportOverride}              override         What the export sets itself
 * @param   {string}                      pandocDirectory  The Pandoc directory (~/.pandoc)
 * @param   {string}                      wikilinkFilter   The wikilink filter of that directory
 */
export function resolveExport(
  item: ExportItem,
  declared: DeclaredDefaults | undefined,
  settings: ExportSettings,
  override: ExportOverride,
  pandocDirectory: string,
  wikilinkFilter: string,
): ResolvedExport {
  const { engine, post } = item;
  const citationLibrary = settings.cslLibrary === "" ? undefined : settings.cslLibrary;
  const stages: ResolvedStage[] = [];
  switch (engine.kind) {
    case "command":
      stages.push({ kind: "command", command: engine.command, runsOn: "document", extension: "" });
      break;
    case "bundle":
      stages.push({ kind: "bundle", format: engine.format });
      break;
    case "recipe": {
      // The template of the export goes before the LaTeX template of the
      // settings; without one the recipe uses its own.
      const template: Sourced | undefined =
        override.template !== undefined && override.template !== ""
          ? { value: override.template, from: "export" }
          : settings.latexTemplate !== ""
            ? { value: settings.latexTemplate, from: "settings" }
            : undefined;
      stages.push({ kind: "recipe", recipe: engine.recipe, template, citationLibrary });
      break;
    }
    case "pandoc": {
      if (declared === undefined) {
        throw new Error(`The export item "${item.id}" has a Pandoc engine and no defaults.`);
      }
      stages.push({
        kind: "pandoc",
        defaultsFile: engine.defaultsFile,
        reader: engine.reader,
        writer: engine.writer,
        filters: effectiveFilters(
          leadingFilters(wikilinkFilter, settings.filters),
          declared.filters,
        ).map(filterName),
        template: effectiveTemplate(engine.writer, declared.template, override, settings),
        citationStyle: effectiveCitationStyle(override, settings),
        citationLibrary,
        math: { owner: mathOwner(engine.writer, settings), pandocDirectory },
      });
      if (post !== undefined) {
        stages.push({
          kind: "command",
          command: post.command,
          runsOn: "pandoc-output",
          extension: post.extension,
        });
      }
      break;
    }
  }
  return { item: item.id, origin: item.origin, stages };
}

/** Where a value comes from, as an author reads it. */
function sourceLabel(sourced: Sourced): string {
  switch (sourced.from) {
    case "export":
      return "Project";
    case "defaults-file":
      return "defaults file";
    case "settings":
      return "settings";
  }
}

/** The last segment of a path, with either separator; a name stays as it is. */
function baseName(value: string): string {
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
}

/**
 * One line for each fact of a resolved export, in the order of its stages:
 * what a window shows beside the item, and what the log keeps of a run.
 */
export function describeResolvedExport(resolved: ResolvedExport): string[] {
  const lines: string[] = [];
  for (const stage of resolved.stages) {
    switch (stage.kind) {
      case "pandoc":
        lines.push(`Pandoc ${stage.reader} → ${stage.writer} (${stage.defaultsFile})`);
        lines.push(`filters: ${stage.filters.map(baseName).join(" › ")}`);
        lines.push(
          stage.template === undefined
            ? "template: Pandoc default"
            : `template: ${baseName(stage.template.value)} (${sourceLabel(stage.template)})`,
        );
        if (stage.citationStyle !== undefined) {
          lines.push(
            `citation style: ${baseName(stage.citationStyle.value)} (${sourceLabel(stage.citationStyle)})`,
          );
        }
        if (stage.math.owner === "application") {
          lines.push(`math: headers of the application, macros of ${stage.math.pandocDirectory}`);
        } else if (stage.math.owner === "template") {
          lines.push("math: the template");
        }
        break;
      case "recipe":
        lines.push(`recipe ${stage.recipe} of ~/.pandoc (its filters, its flags)`);
        lines.push(
          stage.template === undefined
            ? "template: default of the recipe"
            : `template: ${baseName(stage.template.value)} (${sourceLabel(stage.template)})`,
        );
        break;
      case "bundle":
        lines.push(`${stage.format}: the text and its figures, without Pandoc`);
        break;
      case "command":
        lines.push(
          stage.runsOn === "document"
            ? `command on the document: ${stage.command}`
            : `then ${stage.command} → .${stage.extension}`,
        );
        break;
    }
  }
  return lines;
}

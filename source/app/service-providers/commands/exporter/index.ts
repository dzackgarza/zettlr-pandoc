/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Module
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module allows exporting files with Pandoc.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import { EXT2READER, isHtmlWriter, isTexWriter } from "@common/pandoc-util/pandoc-maps";
import {
  enableExtension,
  parseReaderWriter,
  readerWriterToString,
} from "@common/pandoc-util/parse-reader-writer";
// Utilities
import isFile from "@common/util/is-file";
import type { WikilinkIndex } from "@common/util/wikilink-resolution";
import type AssetsProvider from "@providers/assets";
import type ConfigProvider from "@providers/config";
import type { ConfigOptions } from "@providers/config/get-config-template";
import type FSAL from "@providers/fsal";
import type LogProvider from "@providers/log";
import { app } from "electron";
import { promises as fs } from "fs";
// Modules
import path from "path";
import YAML from "yaml";
import { loadCanonicalMathJaxMacros } from "../../../util/load-mathjax-macros";
import { runPandoc } from "../../../util/run-pandoc";
import { runCommandExport } from "./command-exporter";
import { plugin as DefaultExporter } from "./default-exporter";
import { type ExportMath, injectPandocMathHeaders } from "./pandoc-math-headers";
import { runRecipeExport } from "./recipe-exporter";
import { runScriptExport } from "./script-exporter";
import { plugin as TextbundleExporter } from "./textbundle-exporter";
// Exporters
import type { DefaultsOverride, ExporterAPI, ExporterOptions, ExporterOutput } from "./types";
import { exportInputs, withWikilinkMap } from "./wikilink-map-file";

const PLUGINS = {
  pandoc: DefaultExporter,
  textbundle: TextbundleExporter,
};

type PandocDefaults = Record<string, unknown> & {
  reader: string;
  filters: unknown[];
  bibliography: unknown[];
  metadata: Record<string, unknown> & {
    zettlr: Record<string, unknown>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePandocDefaults(value: unknown, filename: string): PandocDefaults {
  if (!isRecord(value) || typeof value.reader !== "string") {
    throw new Error(`Invalid Pandoc defaults profile: ${filename}`);
  }

  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const zettlr = isRecord(metadata.zettlr) ? metadata.zettlr : {};

  return {
    ...value,
    reader: value.reader,
    filters: Array.isArray(value.filters) ? value.filters : [],
    bibliography:
      value.bibliography === undefined
        ? []
        : Array.isArray(value.bibliography)
          ? value.bibliography
          : [value.bibliography],
    metadata: { ...metadata, zettlr },
  };
}

type DefaultsWriterConfig = {
  export: Pick<
    ConfigOptions["export"],
    | "cslLibrary"
    | "cslStyle"
    | "stripTags"
    | "stripLinks"
    | "enforceMarkSupport"
    | "injectMathHeaders"
    | "htmlTemplate"
    | "latexTemplate"
  >;
  zkn: Pick<ConfigOptions["zkn"], "linkFormat">;
};

/**
 * Runs the exporter.
 *
 * @param   {ExporterOptions}  options    The options needed to facilitate the export.
 * @param   {WikilinkIndex}    wikilinks  The index that resolves the wikilinks.
 * @param   fsal                          The folders of the documents, for the
 *                                        bibliography of a PDF export.
 *
 * @return  {Promise<ExporterOutput>}              Resolves with an info object.
 */
export async function makeExport(
  options: ExporterOptions,
  logger: LogProvider,
  config: ConfigProvider,
  assets: AssetsProvider,
  wikilinks: WikilinkIndex,
  fsal: Pick<FSAL, "getAnyDirectoryDescriptor">,
): Promise<ExporterOutput> {
  // The text of each document. Pandoc resolves relative resources against
  // its working directory, not against the folder of an input.
  const inputFiles = options.sourceFiles.map((file) => file.textFile);

  // Load the central ~/.pandoc MathJax projection once for this export.
  const math: ExportMath = {
    mathJaxDirectory: assets.exportMathJaxDirectory,
    macros: await loadCanonicalMathJaxMacros(app.getPath("home")),
    pandocDirectory: path.join(app.getPath("home"), ".pandoc"),
  };

  // Zettlr resolves the wikilinks of a Pandoc export as it does for the PDF
  // recipe: pandoc-config's filters/wikilinks.lua reads the resolutions from
  // the file that PANDOC_WIKILINKS names, and it runs before each other
  // filter, which can add headings.
  const inputs = await exportInputs(options.sourceFiles);
  const reading = { index: wikilinks, linkFormat: config.get().zkn.linkFormat };
  const filters = [
    path.join(math.pandocDirectory, "filters", "wikilinks.lua"),
    ...config.get().export.filters,
  ];

  // This is basically the "plugin API"
  const ctx: ExporterAPI = {
    runPandoc: async (defaults: string) => {
      const output = await withWikilinkMap(
        inputs,
        reading,
        async (mapFile) =>
          await runPandoc(defaults, options.cwd, { ...process.env, PANDOC_WIKILINKS: mapFile }),
      );
      if (output.stdout.length > 0) {
        logger.info("This Pandoc run produced additional output.", output.stdout);
      }
      return output;
    },
    writeDefaults: async (filename: string, overrides: Record<string, unknown> = {}) => {
      const defaults = await assets.getDefaultsFile(filename);

      return await writeDefaults(
        defaults,
        overrides,
        config.get(),
        filters,
        app.getPath("temp"),
        math,
        options.defaultsOverride,
      );
    },
  };

  // The engine of the item decides which exporter runs.
  const { engine, post } = options.item;
  switch (engine.kind) {
    case "bundle":
      return await PLUGINS.textbundle(options, inputFiles, ctx);
    case "recipe": {
      // PDF: the ~/.pandoc compile-pandoc recipe owns each flag. A template
      // of the export (the LaTeX template of a Project) goes before the
      // template of the setting, as it does for a Pandoc engine.
      const ownTemplate = options.defaultsOverride?.template;
      return await runRecipeExport(options, {
        latexTemplate: ownTemplate !== undefined ? ownTemplate : config.get().export.latexTemplate,
        wikilinks: reading,
        fsal,
        mainLibrary: config.get().export.cslLibrary,
      });
    }
    case "command":
      return await runCommandExport(options, engine.command);
    case "pandoc":
      return post === undefined
        ? await PLUGINS.pandoc(options, inputFiles, ctx)
        : await runScriptExport(options, inputFiles, ctx, engine, post);
  }
}

// REFERENCE: Full defaults file here: https://pandoc.org/MANUAL.html#default-files

export async function writeDefaults(
  rawDefaults: unknown,
  properties: Record<string, unknown>, // Contains properties that will be written to the defaults
  config: DefaultsWriterConfig,
  filters: string[],
  temporaryDirectory: string,
  math: ExportMath,
  defaultsOverride?: DefaultsOverride,
): Promise<string> {
  const defaultsFile = path.join(temporaryDirectory, "defaults.yml");
  const defaults = normalizePandocDefaults(rawDefaults, "provided defaults");

  const { cslLibrary, cslStyle, stripTags, stripLinks, enforceMarkSupport } = config.export;
  const { linkFormat } = config.zkn;

  // First step: Reader treatment. Zettlr can modify the reader to align with
  // the user preferences.
  const parsedReader = parseReaderWriter(defaults.reader as string);
  const readsMarkdown = EXT2READER["md"].includes(parsedReader.name);

  // The user can choose to use [[link|title]] or [[title|link]] syntax. In
  // order for the Lua filter to work properly and respect the link removal
  // setting upon export, we need to set the appropriate extension if it is not
  // already set in the `reader` property.
  const linkExt =
    linkFormat === "link|title" ? "wikilinks_title_after_pipe" : "wikilinks_title_before_pipe";
  enableExtension(parsedReader, linkExt);

  // The editor, md2html and the PDF recipe read \( \) and \[ \] as math
  // (AGENTS.md §2); a Markdown reader of an export reads them the same way.
  if (readsMarkdown) {
    enableExtension(parsedReader, "tex_math_single_backslash");
  }

  // Same for the `mark` extension which makes Pandoc correctly parse `==mark==`
  if (readsMarkdown && enforceMarkSupport) {
    enableExtension(parsedReader, "mark");
  }

  // Finally, write the modified reader
  defaults.reader = readerWriterToString(parsedReader);

  // In order to facilitate file-only databases, we need to get the currently
  // selected database. This could break in a lot of places, but until Pandoc
  // respects a file-defined bibliography, this is our best shot.
  // const bibliography = global.citeproc.getSelectedDatabase()
  // An empty setting names no file. A setting that names a file which is
  // absent stops the export: an export without it would have other citations
  // than the author asked for.
  if (cslLibrary !== "") {
    if (!isFile(cslLibrary)) {
      throw new Error(trans("The citation library %s is no file.", cslLibrary));
    }
    defaults.bibliography.push(cslLibrary);
  }

  // The style of the export (that of a Project) goes before the setting.
  const style = defaultsOverride?.csl !== undefined ? defaultsOverride.csl : cslStyle;
  if (style !== "") {
    if (!isFile(style)) {
      throw new Error(trans("The citation style %s is no file.", style));
    }
    defaults.csl = style;
  }

  // Now add metadata values for our GUI settings the user can choose. NOTE that
  // users can also add these manually to their files if they prefer. This way
  // any file's metadata will overwrite anything defined programmatically here
  // in the defaults.
  defaults.metadata.zettlr.strip_tags = stripTags;
  defaults.metadata.zettlr.strip_links = stripLinks;

  // Potentially override allowed defaults properties
  if (defaultsOverride?.title !== undefined) {
    defaults.metadata.title = defaultsOverride.title;
  }

  if (defaultsOverride?.template !== undefined) {
    defaults.template = defaultsOverride.template;
  }

  // Apply a configured default template per writer family when the profile (and
  // any override) leave the template unset. A configured file browses to an
  // absolute path, or a name is resolved from ~/.pandoc/templates.
  if (defaults.template === undefined || defaults.template === "") {
    const writerName = parseReaderWriter(defaults.writer as string).name;
    if (isHtmlWriter(writerName) && config.export.htmlTemplate !== "") {
      defaults.template = config.export.htmlTemplate;
    } else if (isTexWriter(writerName) && config.export.latexTemplate !== "") {
      defaults.template = config.export.latexTemplate;
    }
  }

  // Prepend the declared, ordered export filter chain before the profile's own
  // filters, so structural filters (e.g. amsthm-env conversion) run before the
  // profile's citeproc rather than in filesystem order.
  defaults.filters = [...filters, ...defaults.filters];

  // After we have added our default keys, let the plugin add their keys, which
  // enables them to override certain keys if necessary.
  for (const key in properties) {
    defaults[key] = properties[key];
  }

  // Inject the fork's local MathJax config/preamble unless the user defers math
  // to the profile's template (e.g. a ~/.pandoc template that owns MathJax).
  if (config.export.injectMathHeaders) {
    await injectPandocMathHeaders(defaults as Record<string, unknown>, temporaryDirectory, math);
  }

  const YAMLOptions = {
    indent: 4,
    simpleKeys: false,
  };
  await fs.writeFile(defaultsFile, YAML.stringify(defaults, YAMLOptions), { encoding: "utf8" });

  // Return the path to the defaults file
  return defaultsFile;
}

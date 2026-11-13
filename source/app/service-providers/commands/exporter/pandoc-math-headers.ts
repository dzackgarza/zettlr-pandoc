import { isHtmlWriter, isTexWriter } from "@common/pandoc-util/pandoc-maps";
import { parseReaderWriter } from "@common/pandoc-util/parse-reader-writer";
import { type MathJaxMacro, mathJaxPackages } from "@dzack/tikz-render/mathjax-config";
import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { promisify } from "util";
import { MacroSourcesUnavailableError } from "../../../util/load-mathjax-macros";

const execFileAsync = promisify(execFile);

/**
 * The package of the macro tree that holds the macros of the MathJax
 * projection: it inputs the files of `styles/macros/mathjax-sources.txt`
 * (`~/.pandoc/styles/macros/README.md`).
 */
const MACRO_PACKAGE = "dzg-mathjax";

/** The math of an export. */
export interface ExportMath {
  /** The folder of the MathJax of an HTML export (`scripts/export-mathjax.js`). */
  mathJaxDirectory: string;
  /** The MathJax projection of the macro tree, for an HTML export. */
  macros: Record<string, MathJaxMacro>;
  /** The ~/.pandoc directory, whose `styles` hold the macro tree of a TeX export. */
  pandocDirectory: string;
}

/**
 * The preamble text of the macro package of the macro tree, with the text of
 * each file that it inputs. latexpand (TeX Live) writes it; the exported TeX
 * file therefore compiles without ~/.pandoc, with the definitions of the
 * macro tree.
 */
async function texMacroHeader(
  pandocDirectory: string,
  temporaryDirectory: string,
): Promise<string> {
  const styles = path.join(pandocDirectory, "styles");
  const pkg = path.join(styles, `${MACRO_PACKAGE}.sty`);
  if (!existsSync(pkg)) {
    throw new MacroSourcesUnavailableError(`The macro package ${pkg} does not exist.`);
  }
  const source = path.join(temporaryDirectory, "zettlr-macro-package.tex");
  await fs.writeFile(source, `\\usepackage{${MACRO_PACKAGE}}\n`, "utf8");
  // latexpand puts a package into the text only when TEXINPUTS finds it, and
  // --fatal stops it at a file of an \input that it cannot find.
  const { stdout } = await execFileAsync("latexpand", ["--fatal", "--expand-usepackage", source], {
    env: { ...process.env, TEXINPUTS: `${styles}//` },
  });
  // A package can name commands with @.
  return `\\makeatletter\n${stdout}\n\\makeatother\n`;
}

function headerFiles(defaults: Record<string, unknown>): string[] {
  const headers = defaults["include-in-header"];

  if (headers === undefined) {
    return [];
  }
  if (typeof headers === "string") {
    return [headers];
  }
  if (Array.isArray(headers) && headers.every((header) => typeof header === "string")) {
    return headers;
  }

  throw new TypeError("Pandoc include-in-header must be a string or an array of strings");
}

/**
 * Writes format-specific macro headers and attaches them to Pandoc defaults.
 */
export async function injectPandocMathHeaders(
  defaults: Record<string, unknown>,
  temporaryDirectory: string,
  math: ExportMath,
): Promise<void> {
  const writer = parseReaderWriter(defaults.writer as string).name;
  const { mathJaxDirectory, macros } = math;

  if (isHtmlWriter(writer)) {
    const header = path.join(temporaryDirectory, "zettlr-mathjax-header.html");
    const fileUrl = (name: string): string => pathToFileURL(path.join(mathJaxDirectory, name)).href;
    const config = JSON.stringify(
      {
        loader: {
          paths: {
            tex: `${fileUrl("tex-extensions")}/`,
            fonts: `${pathToFileURL(mathJaxDirectory).href}/`,
            sre: fileUrl("sre"),
            mathmaps: fileUrl(path.join("sre", "mathmaps")),
          },
          load: ["[tex]/boldsymbol", "[tex]/mhchem"],
        },
        options: {
          enableSpeech: false,
          enableBraille: false,
          enableEnrichment: false,
          a11y: {
            speech: false,
            braille: false,
          },
          renderActions: {
            assistiveMml: [],
          },
          worker: {
            path: fileUrl("sre"),
            maps: fileUrl(path.join("sre", "mathmaps")),
            worker: "speech-worker.js",
          },
        },
        tex: {
          packages: { "[+]": mathJaxPackages.slice(1) },
          macros,
        },
        chtml: {
          fontURL: fileUrl(path.join("font", "woff2")),
          dynamicPrefix: fileUrl(path.join("font", "dynamic")),
        },
      },
      null,
      2,
    ).replace(/<\/script/gi, "<\\/script");

    // The header goes before the script of the math method in the templates
    // of Pandoc, so MathJax starts with this configuration.
    await fs.writeFile(header, `<script>\nwindow.MathJax = ${config};\n</script>\n`, {
      encoding: "utf8",
    });
    defaults["include-in-header"] = [...headerFiles(defaults), header];
    // Pandoc writes each formula as TeX between \( \) or \[ \] and loads the
    // component of the application, which typesets all of them.
    defaults["html-math-method"] = { method: "mathjax", url: fileUrl("tex-chtml.js") };
  } else if (isTexWriter(writer)) {
    const header = path.join(temporaryDirectory, "zettlr-mathjax-header.tex");
    const macroHeader = await texMacroHeader(math.pandocDirectory, temporaryDirectory);
    await fs.writeFile(header, `\\usepackage[version=4]{mhchem}\n${macroHeader}`, {
      encoding: "utf8",
    });
    defaults["include-in-header"] = [...headerFiles(defaults), header];
  }
}

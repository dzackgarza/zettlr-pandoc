/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The math of a Pandoc export
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The template of an export owns its math, and the
 *                  application gives an HTML export two places: the MathJax
 *                  component and the folder of the MathJax fonts
 *                  (`exporter/export-math.ts`). These tests run the real
 *                  Pandoc with the real templates of ~/.pandoc (the
 *                  pandoc-config of the machine) and the MathJax that the
 *                  application brings. The HTML page is opened in Chromium:
 *                  a macro of ~/.pandoc, a bold symbol and a chemical
 *                  formula are typeset, and the page asks no other machine
 *                  for anything.
 *
 * END HEADER
 */

import { pathToFileURL } from "node:url";
import assert from "assert";
import { execFile } from "child_process";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  MATHJAX_FONTS_VARIABLE,
  MATHJAX_ROOT_VARIABLE,
  setMathPlaces,
} from "source/app/service-providers/commands/exporter/export-math";
import { writeDefaults } from "source/app/service-providers/commands/exporter/index";
import { promisify } from "util";
import YAML from "yaml";
import { copyExportMathJax } from "../scripts/export-mathjax.js";
import { runProbe } from "./visual/display-probe";

const execFileAsync = promisify(execFile);

/** The Pandoc directory of the machine: the templates that own the math. */
const PANDOC_DIRECTORY = path.join(os.homedir(), ".pandoc");

const config = {
  export: {
    cslLibrary: "",
    cslStyle: "",
    stripTags: false,
    stripLinks: "no" as const,
    enforceMarkSupport: false,
    htmlTemplate: "",
    latexTemplate: "",
  },
  zkn: { linkFormat: "link|title" as const },
};

/** Writes the defaults of an export of `source` with a profile, and runs Pandoc with them. */
async function exported(
  profileFile: string,
  source: string,
  extension: string,
  mathJaxDirectory: string,
): Promise<{ directory: string; outputFile: string; output: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-math-"));
  const inputFile = path.join(directory, "input.md");
  const outputFile = path.join(directory, `output.${extension}`);
  await writeFile(inputFile, source);
  const defaultsFile = await writeDefaults(
    YAML.parse(await readFile(profileFile, { encoding: "utf8" })),
    { "input-files": [inputFile], "output-file": outputFile, standalone: true },
    config,
    [],
    directory,
    { mathJaxDirectory, pandocDirectory: PANDOC_DIRECTORY },
  );
  await execFileAsync("pandoc", ["--defaults", defaultsFile]);
  return { directory, outputFile, output: await readFile(outputFile, { encoding: "utf8" }) };
}

describe("The math of a Pandoc export", function () {
  it("names the MathJax of the application in HTML defaults and keeps their variables", function () {
    const mathJaxDirectory = path.join(os.tmpdir(), "mathjax of the application");
    const defaults: Record<string, unknown> = {
      writer: "html",
      variables: { lang: "en" },
      "include-in-header": ["own.html"],
    };

    setMathPlaces(defaults, { mathJaxDirectory, pandocDirectory: PANDOC_DIRECTORY });

    assert.deepEqual(defaults, {
      writer: "html",
      variables: {
        lang: "en",
        [MATHJAX_ROOT_VARIABLE]: pathToFileURL(mathJaxDirectory).href,
        [MATHJAX_FONTS_VARIABLE]: pathToFileURL(path.join(mathJaxDirectory, "fonts")).href,
      },
      "include-in-header": ["own.html"],
      "html-math-method": {
        method: "mathjax",
        url: pathToFileURL(path.join(mathJaxDirectory, "tex-chtml.js")).href,
      },
    });
  });

  it("leaves the defaults of a writer that is no HTML writer as they are", function () {
    for (const writer of ["latex", "docx", "plain"]) {
      const defaults: Record<string, unknown> = { writer, "include-in-header": [] };
      setMathPlaces(defaults, { mathJaxDirectory: "/mathjax", pandocDirectory: PANDOC_DIRECTORY });
      assert.deepEqual(defaults, { writer, "include-in-header": [] });
    }
  });

  it("typesets a macro of ~/.pandoc, a bold symbol and a chemical formula in an HTML export, with no request to another machine", async function () {
    this.timeout(60_000);
    const mathJax = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-mathjax-"));
    await copyExportMathJax(mathJax);

    const { directory, outputFile, output } = await exported(
      "static/defaults/HTML.yaml",
      "$\\ZZ$ and $\\boldsymbol{\\iota}$ and $\\ce{H2O}$\n",
      "html",
      mathJax,
    );

    // The page has one MathJax configuration, that of the template with the
    // macros. The application wrote none; the template names the two folders
    // that the application gave it. The profile makes a self-contained page,
    // so Pandoc put the component itself into the page.
    assert.equal(output.split("window.MathJax =").length - 1, 1, "one MathJax configuration");
    assert.ok(
      output.includes(`mathjax: "${pathToFileURL(mathJax).href}",`),
      "the template names the folder of the MathJax of the application",
    );
    assert.ok(
      output.includes(`fonts: "${pathToFileURL(path.join(mathJax, "fonts")).href}",`),
      "the template names the fonts of the application",
    );

    const rendered = path.join(directory, "rendered.html");
    await runProbe(path.join(process.cwd(), "test/pandoc-math-html-probe.mjs"), [
      outputFile,
      path.join(directory, "render.png"),
      rendered,
    ]);
    const html = await readFile(rendered, { encoding: "utf8" });
    assert.equal(html.split("<mjx-container").length - 1, 3, "three formulas are typeset");
    // MathJax shows a macro that it does not know as its own text.
    for (const formula of ["\\ZZ", "\\boldsymbol{\\iota}", "\\ce{H2O}"]) {
      assert.ok(html.includes(`<mjx-math data-latex="${formula}"`), `${formula} is a formula`);
      assert.ok(
        !html.includes(`<mjx-mtext data-latex="${formula}"`),
        `${formula} is typeset, not shown as text`,
      );
    }
    assert.ok(!html.includes("<mjx-merror"), "no formula has an error");
    assert.deepEqual(
      JSON.parse(await readFile(`${rendered}.requests.json`, { encoding: "utf8" })),
      [],
      "the page asks no other machine for anything",
    );
  });

  it("gives a reveal.js deck the macros of ~/.pandoc through the MathJax 3 plugin, with the MathJax of the application", async function () {
    this.timeout(60_000);
    const mathJax = path.join(os.tmpdir(), "zettlr-export-mathjax-of-a-deck");
    const profile = YAML.parse(
      await readFile("static/defaults/Reveal.js.yaml", { encoding: "utf8" }),
    ) as Record<string, unknown>;
    // The profile embeds reveal.js itself, which Pandoc gets from the
    // network. This test reads the deck as text and needs no reveal.js.
    profile["embed-resources"] = false;
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-math-"));
    const profileFile = path.join(directory, "Reveal.js.yaml");
    await writeFile(profileFile, YAML.stringify(profile));

    const { output } = await exported(profileFile, "# Slide\n\n$\\ZZ$\n", "html", mathJax);

    assert.ok(output.includes("RevealMath.MathJax3"), "the MathJax 3 plugin is a plugin");
    assert.ok(
      output.includes(`mathjax: '${pathToFileURL(path.join(mathJax, "tex-chtml.js")).href}'`),
      "the plugin loads the MathJax of the application",
    );
    assert.ok(
      output.includes(`mathjax: '${pathToFileURL(mathJax).href}',`),
      "the deck names the folder of the MathJax of the application",
    );
    assert.ok(
      output.includes(`fonts: '${pathToFileURL(path.join(mathJax, "fonts")).href}',`),
      "the deck names the fonts of the application",
    );
    assert.ok(/macros: \{.*"ZZ":/.test(output), "the deck has the macros of ~/.pandoc");
  });

  it("gives a LaTeX export the template of ~/.pandoc, which loads the macro style", async function () {
    this.timeout(60_000);
    const { output } = await exported(
      "static/defaults/LaTeX.yaml",
      "$\\ZZ$\n",
      "tex",
      path.join(os.tmpdir(), "no-mathjax-for-tex"),
    );

    const template = await readFile(
      path.join(PANDOC_DIRECTORY, "templates", "research_draft.tex"),
      { encoding: "utf8" },
    );
    const firstPackage = template.split("\n").find((line) => line.startsWith("\\usepackage"));
    assert.ok(firstPackage !== undefined, "the template of ~/.pandoc loads a package");
    assert.ok(output.includes(firstPackage), "the document is made with that template");
    assert.ok(output.includes("\\ZZ"), "the formula keeps its macro");
    assert.ok(!output.includes("zettlr-mathjax"), "the application adds no header");
  });
});

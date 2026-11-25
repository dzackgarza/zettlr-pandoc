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
 *                  for anything. Each other writer gets the macros from the
 *                  first input of the export (`MacroInput`): its output
 *                  holds the expansion of a macro, and ConTeXt typesets it.
 *
 * END HEADER
 */

import { pathToFileURL } from "node:url";
import assert from "assert";
import { execFile, execFileSync } from "child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "fs/promises";
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

/** TeX finds the styles of ~/.pandoc where the TeX of the author finds them. */
const TEX_ENVIRONMENT = {
  ...process.env,
  TEXINPUTS: `${path.join(PANDOC_DIRECTORY, "styles")}//:`,
};

/** A profile of the application with other values for some of its keys. */
async function profileOf(
  profileFile: string,
  changes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const profile = YAML.parse(await readFile(profileFile, { encoding: "utf8" })) as Record<
    string,
    unknown
  >;
  return { ...profile, ...changes };
}

/**
 * Writes the defaults of an export of `source` with a profile, and runs Pandoc
 * with them. The output of a writer that writes a folder (chunkedhtml) is the
 * text of its pages.
 */
async function exported(
  profile: Record<string, unknown>,
  source: string,
  outputName: string,
  mathJaxDirectory: string,
): Promise<{ directory: string; outputFile: string; output: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-math-"));
  const inputFile = path.join(directory, "input.md");
  const outputFile = path.join(directory, outputName);
  await writeFile(inputFile, source);
  const defaultsFile = await writeDefaults(
    profile,
    { "input-files": [inputFile], "output-file": outputFile, standalone: true },
    config,
    [],
    directory,
    { mathJaxDirectory, pandocDirectory: PANDOC_DIRECTORY },
  );
  await execFileAsync("pandoc", ["--defaults", defaultsFile], { env: TEX_ENVIRONMENT });
  if (outputName.endsWith(".pdf")) {
    return { directory, outputFile, output: "" };
  }
  if ((await stat(outputFile)).isDirectory()) {
    const pages = (await readdir(outputFile)).filter((name) => name.endsWith(".html")).sort();
    const texts = await Promise.all(
      pages.map((name) => readFile(path.join(outputFile, name), { encoding: "utf8" })),
    );
    return { directory, outputFile, output: texts.join("\n") };
  }
  return { directory, outputFile, output: await readFile(outputFile, { encoding: "utf8" }) };
}

/** The text of a PDF. */
function pdfText(pdfFile: string): string {
  return execFileSync("pdftotext", [pdfFile, "-"], { encoding: "utf8" });
}

/** The text of the members of an archive (docx, odt, epub) whose names match a pattern. */
function archiveText(archive: string, member: string): string {
  return execFileSync("unzip", ["-p", archive, member], { encoding: "utf8" });
}

/**
 * A program of the TeX distribution that kpsewhich belongs to. ConTeXt finds
 * its tree from the path by which it runs; through a link in /usr/bin it
 * finds no texmfcnf.lua ("unknown script mtx-context.lua").
 */
function texProgram(name: string): string {
  const bin = execFileSync("kpsewhich", ["-var-value=SELFAUTOLOC"], { encoding: "utf8" }).trim();
  return path.join(bin, name);
}

/** A formula of the expansion of `\Hom(\ZZ, \QQ)` in the MathML of texmath. */
const HOM_MATHML = /<(mml:)?mi mathvariant="normal">Hom<\/(mml:)?mi>/;
const HOM_SOURCE = "---\ntitle: Macros\n---\n\nThe set $\\Hom(\\ZZ, \\QQ)$.\n";

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
      await profileOf("static/defaults/HTML.yaml", {}),
      "$\\ZZ$ and $\\boldsymbol{\\iota}$ and $\\ce{H2O}$\n",
      "output.html",
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
    // The profile embeds reveal.js itself, which Pandoc gets from the
    // network. This test reads the deck as text and needs no reveal.js.
    const profile = await profileOf("static/defaults/Reveal.js.yaml", {
      "embed-resources": false,
    });

    const { output } = await exported(profile, "# Slide\n\n$\\ZZ$\n", "output.html", mathJax);

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
      await profileOf("static/defaults/LaTeX.yaml", {}),
      "$\\ZZ$\n",
      "output.tex",
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
  it("gives each other HTML writer the MathJax configuration of ~/.pandoc, with the MathJax of the application", async function () {
    this.timeout(60_000);
    const mathJax = path.join(os.tmpdir(), "zettlr-export-mathjax-of-a-page");
    const writers = [
      { writer: "s5", output: "output.html" },
      { writer: "slidy", output: "output.html" },
      { writer: "slideous", output: "output.html" },
      { writer: "dzslides", output: "output.html" },
      // chunkedhtml writes a folder with one page for each section.
      { writer: "chunkedhtml", output: "output" },
    ];
    for (const { writer, output: outputName } of writers) {
      // The HTML profile makes a self-contained page; the slide writers then
      // want their scripts and styles, which this test does not need.
      const profile = await profileOf("static/defaults/HTML.yaml", {
        writer,
        "self-contained": false,
      });
      const { output } = await exported(profile, "# A slide\n\n$\\ZZ$\n", outputName, mathJax);

      const config = output.indexOf("window.MathJax = {");
      const script = output.indexOf(pathToFileURL(path.join(mathJax, "tex-chtml.js")).href);
      assert.ok(
        config >= 0 && config < script,
        `${writer}: the configuration of the template comes before the MathJax of the application`,
      );
      assert.ok(
        /macros: \{.*"ZZ":/.test(output.slice(config, script)),
        `${writer}: the configuration has the macros of ~/.pandoc`,
      );
      assert.ok(
        output.includes(`mathjax: "${pathToFileURL(mathJax).href}",`),
        `${writer}: the page names the folder of the MathJax of the application`,
      );
      assert.ok(
        output.includes(`fonts: "${pathToFileURL(path.join(mathJax, "fonts")).href}",`),
        `${writer}: the page names the fonts of the application`,
      );
    }
  });

  it("typesets a macro of ~/.pandoc with pdflatex in a Beamer export and a PDF export", async function () {
    this.timeout(120_000);
    const source = "---\ntitle: Macros\n---\n\n# A slide\n\nThe set $\\Hom(\\ZZ, \\QQ)$.\n";
    const latex = "static/defaults/LaTeX.yaml";

    const beamer = await exported(
      await profileOf(latex, { writer: "beamer" }),
      source,
      "slides.tex",
      path.join(os.tmpdir(), "no-mathjax-for-tex"),
    );
    execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "slides.tex"], {
      cwd: beamer.directory,
      env: TEX_ENVIRONMENT,
    });

    // The LaTeX profile makes a heading of level 1 a chapter, which the
    // amsart class of research_draft.tex does not have (#234); the PDF
    // document has no heading.
    const pdf = await exported(
      await profileOf(latex, { writer: "pdf", "pdf-engine": "pdflatex" }),
      "The set $\\Hom(\\ZZ, \\QQ)$.\n",
      "output.pdf",
      path.join(os.tmpdir(), "no-mathjax-for-tex"),
    );

    // The macro tree makes \Hom an operator and \ZZ, \QQ bold letters; a
    // TeX without the macros stops at the first of them.
    for (const pdfFile of [path.join(beamer.directory, "slides.pdf"), pdf.outputFile]) {
      const text = pdfText(pdfFile);
      assert.ok(text.includes("The set Hom(Z, Q)."), text);
    }
  });

  it("gives each other writer the expansion of a macro of ~/.pandoc, and no definition", async function () {
    this.timeout(120_000);
    const noMathJax = path.join(os.tmpdir(), "no-mathjax-for-this-writer");
    const word = "static/defaults/Microsoft Word.yaml";
    const cases: Array<{
      profile: Record<string, unknown>;
      outputName: string;
      formula: (outputFile: string, output: string) => string;
      expansion: RegExp;
    }> = [
      {
        profile: await profileOf(word, {}),
        outputName: "output.docx",
        // OMML puts each run of a formula in an <m:t> of its own.
        formula: (file) =>
          [...archiveText(file, "word/document.xml").matchAll(/<m:t[^>]*>([^<]*)<\/m:t>/g)]
            .map((match) => match[1])
            .join(""),
        expansion: /^Hom\(Z,Q\)$/,
      },
      {
        profile: await profileOf("static/defaults/Open Document Text.yaml", {}),
        outputName: "output.odt",
        formula: (file) => archiveText(file, "Formula-*/content.xml"),
        expansion: HOM_MATHML,
      },
      {
        profile: await profileOf(word, { writer: "epub3" }),
        outputName: "output.epub",
        formula: (file) => archiveText(file, "*.xhtml"),
        expansion: HOM_MATHML,
      },
      {
        profile: await profileOf(word, { writer: "jats" }),
        outputName: "output.xml",
        formula: (_file, output) => output,
        expansion: HOM_MATHML,
      },
      {
        profile: await profileOf("static/defaults/Markdown.yaml", {}),
        outputName: "output.markdown",
        formula: (_file, output) => output,
        expansion: /\$`\{ \\operatorname\{Hom\} \}\(\{\\mathbf\{Z\}\}, \{\\mathbf\{Q\}\}\)`\$/,
      },
      {
        profile: await profileOf("static/defaults/Plain Text.yaml", {}),
        outputName: "output.txt",
        formula: (_file, output) => output,
        // The plain writer puts a thin space after an operator and a comma.
        expansion: /The set Hom\s?\(Z,\s?Q\)\./,
      },
    ];
    for (const { profile, outputName, formula, expansion } of cases) {
      const { outputFile, output } = await exported(profile, HOM_SOURCE, outputName, noMathJax);
      const text = formula(outputFile, output);
      assert.match(text, expansion, `${String(profile.writer)}: the formula is the expansion`);
      for (const raw of ["\\ZZ", "\\Hom", "newcommand", "math-macros"]) {
        assert.ok(!text.includes(raw), `${String(profile.writer)}: the output has no ${raw}`);
      }
    }
  });

  it("typesets a macro of ~/.pandoc with ConTeXt in a ConTeXt export", async function () {
    this.timeout(180_000);
    const exportedFile = await exported(
      await profileOf("static/defaults/Microsoft Word.yaml", { writer: "context" }),
      HOM_SOURCE,
      "output.tex",
      path.join(os.tmpdir(), "no-mathjax-for-context"),
    );

    // The template of ~/.pandoc loads the MathML module of ConTeXt, and each
    // formula is the MathML of texmath: ConTeXt is no LaTeX and does not
    // define \operatorname of the expansion.
    assert.ok(exportedFile.output.includes("\\usemodule[mathml]"), "the template of ~/.pandoc");
    assert.ok(exportedFile.output.includes("\\startmml"), "the formula is MathML");
    execFileSync(texProgram("context"), ["--batchmode", "--nonstopmode", "output.tex"], {
      cwd: exportedFile.directory,
    });
    const text = pdfText(path.join(exportedFile.directory, "output.pdf"));
    // texmath gives a letter of \mathbf the variant bold-italic (U+1D481).
    assert.match(text, /The set Hom\(𝒁, 𝑸\)\./u);
  });

  it("refuses an export whose reader cannot expand the macros of ~/.pandoc for its writer", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-math-reader-"));
    await assert.rejects(
      writeDefaults(
        await profileOf("static/defaults/Microsoft Word.yaml", { reader: "commonmark_x" }),
        { "input-files": [path.join(directory, "input.md")], "output-file": "out.docx" },
        config,
        [],
        directory,
        { mathJaxDirectory: "/mathjax", pandocDirectory: PANDOC_DIRECTORY },
      ),
      /The export reads commonmark_x\. The writer docx gets the macros of ~\/\.pandoc only from the reader markdown/,
    );
  });

  it("refuses an export when the Pandoc directory has no macro input", async function () {
    const pandocDirectory = await mkdtemp(path.join(os.tmpdir(), "zettlr-pandoc-directory-"));
    await assert.rejects(
      writeDefaults(
        await profileOf("static/defaults/Microsoft Word.yaml", {}),
        { "input-files": [], "output-file": "out.docx" },
        config,
        [],
        pandocDirectory,
        { mathJaxDirectory: "/mathjax", pandocDirectory },
      ),
      (error: Error) =>
        error.message.includes(path.join(pandocDirectory, "templates/css/math-macros.md")),
    );
  });
});

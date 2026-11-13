import { pathToFileURL } from "node:url";
import type { MathJaxMacro } from "@dzack/tikz-render/mathjax-config";
import assert from "assert";
import { execFile } from "child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { writeDefaults } from "source/app/service-providers/commands/exporter/index";
import { injectPandocMathHeaders } from "source/app/service-providers/commands/exporter/pandoc-math-headers";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import { promisify } from "util";
import { runInNewContext } from "vm";
import YAML from "yaml";
import { copyExportMathJax } from "../scripts/export-mathjax.js";
import { runProbe } from "./visual/display-probe";

// Example macro fixture loaded through the real loader; the app ships none.
// The ~/.pandoc directory of an export: its macro tree.
const MACRO_TREE = path.resolve("test", "fixtures", "pandoc-macros");
let macros: Record<string, MathJaxMacro>;
before(async function () {
  macros = await loadMathJaxMacros("test/fixtures/mathjax-macros.json");
});

interface MathJaxWindow {
  MathJax?: {
    loader?: {
      load?: string[];
      paths?: Record<string, string>;
    };
    tex?: {
      macros?: Record<string, unknown>;
      packages?: Record<string, string[]>;
    };
    chtml?: {
      fontURL?: string;
    };
  };
}

/** A list that a script made in its own context, as an array of this realm. */
function inThisRealm(list: string[] | undefined): string[] {
  assert.ok(list !== undefined, "The configuration holds the list");
  return Array.from(list);
}

const execFileAsync = promisify(execFile);

async function runPandoc(defaultsFile: string, outputFile: string): Promise<string> {
  await execFileAsync("pandoc", ["--defaults", defaultsFile]);
  return await readFile(outputFile, { encoding: "utf8" });
}

describe("Pandoc math export headers", function () {
  it("runs real Pandoc HTML with macro config before the local MathJax component", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-pandoc-html-"));
    const inputFile = path.join(directory, "input.md");
    const outputFile = path.join(directory, "output.html");
    const defaultsFile = path.join(directory, "defaults.yaml");
    const existingHeader = path.join(directory, "existing.html");
    const mathJax = path.join(directory, "mathjax");
    const defaults = YAML.parse(
      await readFile("static/defaults/HTML.yaml", { encoding: "utf8" }),
    ) as Record<string, unknown>;
    defaults.standalone = true;
    defaults["input-files"] = [inputFile];
    defaults["output-file"] = outputFile;
    defaults["include-in-header"] = [existingHeader];

    await writeFile(inputFile, "$\\RR$ and $\\ce{H2O}$\n");
    await writeFile(existingHeader, '<meta name="preserved-header" content="yes">');
    await copyExportMathJax(mathJax);
    await injectPandocMathHeaders(defaults, directory, {
      mathJaxDirectory: mathJax,
      macros,
      pandocDirectory: MACRO_TREE,
    });
    await writeFile(
      defaultsFile,
      Object.entries(defaults)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n"),
    );

    const html = await runPandoc(defaultsFile, outputFile);
    const configHeader = (defaults["include-in-header"] as string[])[1];
    const config = await readFile(configHeader, { encoding: "utf8" });
    const window: MathJaxWindow = {};
    for (const script of config.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      runInNewContext(script[1], { window });
    }

    assert.strictEqual(window.MathJax?.tex?.macros?.RR, "\\mathbb{R}");
    assert.deepStrictEqual(inThisRealm(window.MathJax?.loader?.load), [
      "[tex]/boldsymbol",
      "[tex]/mhchem",
    ]);
    assert.strictEqual(
      window.MathJax?.loader?.paths?.tex,
      `${pathToFileURL(path.join(mathJax, "tex-extensions")).href}/`,
    );
    assert.strictEqual(window.MathJax?.loader?.paths?.fonts, `${pathToFileURL(mathJax).href}/`);
    assert.deepStrictEqual(inThisRealm(window.MathJax?.tex?.packages?.["[+]"]), [
      "ams",
      "boldsymbol",
      "configmacros",
      "mhchem",
      "newcommand",
      "noundefined",
    ]);
    assert.match(String(window.MathJax?.chtml?.fontURL), /^file:\/\//);
    assert.match(config, /"RR": "\\\\mathbb\{R\}"/);
    assert.match(config, /"mhchem"/);
    assert.match(config, /"fontURL": "file:\/\//);
    // Pandoc keeps each formula as TeX for the component of the application.
    assert.deepStrictEqual(defaults["html-math-method"], {
      method: "mathjax",
      url: pathToFileURL(path.join(mathJax, "tex-chtml.js")).href,
    });
    assert.ok(html.includes('<span class="math inline">\\(\\RR\\)</span>'));
    assert.ok(html.includes('<span class="math inline">\\(\\ce{H2O}\\)</span>'));
    // The configuration comes before the component, which reads it at its start.
    assert.ok(html.indexOf("window.MathJax =") < html.indexOf("MathJax.version"));
    assert.ok(html.includes("preserved-header"));
  });

  it("renders canonical macros, boldsymbol, and mhchem in a local Chromium HTML export", async function () {
    this.timeout(30000);
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-pandoc-browser-"));
    const inputFile = path.join(directory, "input.md");
    const outputFile = path.join(directory, "output.html");
    const mathJax = path.join(directory, "mathjax");
    const screenshot = path.join(directory, "render.png");
    const renderedDocument = path.join(directory, "rendered.html");

    await copyExportMathJax(mathJax);
    await writeFile(inputFile, "$\\RR$ and $\\boldsymbol{\\iota}$ and $\\ce{H2O}$\n");

    const config = {
      export: {
        cslLibrary: "",
        cslStyle: "",
        stripTags: false,
        stripLinks: "no" as const,
        enforceMarkSupport: false,
        injectMathHeaders: true,
        htmlTemplate: "",
        latexTemplate: "",
      },
      zkn: { linkFormat: "link|title" as const },
    };
    const defaultsFile = await writeDefaults(
      YAML.parse(await readFile("static/defaults/HTML.yaml", { encoding: "utf8" })),
      {
        "input-files": [inputFile],
        "output-file": outputFile,
        standalone: true,
      },
      config,
      [],
      directory,
      { mathJaxDirectory: mathJax, macros, pandocDirectory: MACRO_TREE },
    );

    await runPandoc(defaultsFile, outputFile);
    const { stdout, stderr } = await runProbe(
      path.join(process.cwd(), "test/pandoc-math-html-probe.mjs"),
      [outputFile, screenshot, renderedDocument],
    );
    const html = await readFile(renderedDocument, { encoding: "utf8" });

    assert.strictEqual(html.split("<mjx-container").length - 1, 3);
    const configScript = html.match(/window\.MathJax = ([\s\S]*?)<\/script>/);
    assert.ok(configScript !== null, "The page holds the MathJax configuration");
    const mathJaxConfig = configScript[1];
    assert.ok(!mathJaxConfig.includes("https://"));
    assert.ok(!mathJaxConfig.includes("http://"));
    assert.ok(html.includes('data-latex="\\mathbb{R}"'));
    assert.ok(html.includes('data-latex="\\boldsymbol{\\iota}"'));
    assert.ok(html.includes('data-latex="\\ce{H2O}"'));
    // The xvfb-run of some distributions joins the error output of the probe
    // to its output.
    const probeOutput = stdout + stderr;
    assert.ok(!probeOutput.includes("MathJax Warning: Package 'boldsymbol' not found"));
    assert.ok(!probeOutput.includes("MathJax Warning: Package 'mhchem' not found"));
  });
  it("writes copied Reveal defaults through the exporter seam before real Pandoc output", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-pandoc-write-defaults-"));
    const defaultsDirectory = path.join(directory, "defaults");
    const filterDirectory = path.join(directory, "filters");
    const inputFile = path.join(directory, "input.md");
    const outputFile = path.join(directory, "output.html");
    const existingHeader = path.join(directory, "existing.html");
    const copiedDefaults = path.join(defaultsDirectory, "Copied Reveal.yaml");
    const mathJax = path.join(directory, "mathjax");
    const template = path.join(directory, "project-template.html");

    await mkdir(defaultsDirectory, { recursive: true });
    await mkdir(filterDirectory, { recursive: true });
    await cp("static/defaults/Reveal.js.yaml", copiedDefaults);
    await copyExportMathJax(mathJax);
    await writeFile(inputFile, "$\\RR$ and $\\ce{H2O}$\n");
    await writeFile(existingHeader, '<meta name="preserved-header" content="yes">');
    await writeFile(
      template,
      "<!doctype html><html><head>$for(include-in-header)$$include-in-header$$endfor$</head><body>$body$</body></html>",
    );

    const config = {
      export: {
        cslLibrary: "",
        cslStyle: "",
        stripTags: false,
        stripLinks: "no" as const,
        enforceMarkSupport: false,
        injectMathHeaders: true,
        htmlTemplate: "",
        latexTemplate: "",
      },
      zkn: { linkFormat: "link|title" as const },
    };
    const defaultsFile = await writeDefaults(
      YAML.parse(await readFile(copiedDefaults, { encoding: "utf8" })),
      {
        "input-files": [inputFile],
        "output-file": outputFile,
        standalone: true,
        template,
        "include-in-header": [existingHeader],
      },
      config,
      [],
      directory,
      { mathJaxDirectory: mathJax, macros, pandocDirectory: MACRO_TREE },
    );
    const defaults = YAML.parse(await readFile(defaultsFile, { encoding: "utf8" })) as Record<
      string,
      unknown
    >;
    const headers = defaults["include-in-header"] as string[];
    const html = await runPandoc(defaultsFile, outputFile);

    assert.strictEqual(defaults.writer, "revealjs");
    assert.strictEqual(defaults.template, template);
    assert.strictEqual(headers[0], existingHeader);
    assert.strictEqual(headers.length, 2);
    assert.match(await readFile(headers[1], { encoding: "utf8" }), /window\.MathJax/);
    assert.match(html, /<section class="slide level6">/);
    assert.match(html, /\\RR/);
    assert.match(html, /\\ce\{H2O\}/);
  });
  it("classifies copied Reveal, LaTeX, and plain-text profile defaults at the shared header seam", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-pandoc-profiles-"));
    const existingHeader = path.join(directory, "existing-header");
    const fixtureNames = ["Reveal.js.yaml", "LaTeX.yaml", "Plain Text.yaml"];
    const profileDirectories = ["reveal", "latex", "plain"].map((name) =>
      path.join(directory, name),
    );
    await Promise.all(
      profileDirectories.map(async (profileDirectory, index) => {
        await mkdir(profileDirectory, { recursive: true });
        await cp(
          path.join("static/defaults", fixtureNames[index]),
          path.join(profileDirectory, "copied-defaults.yaml"),
        );
      }),
    );
    const profiles = await Promise.all(
      profileDirectories.map(
        async (profileDirectory) =>
          YAML.parse(
            await readFile(path.join(profileDirectory, "copied-defaults.yaml"), {
              encoding: "utf8",
            }),
          ) as Record<string, unknown>,
      ),
    );

    await writeFile(existingHeader, "preserved");

    for (const [index, defaults] of profiles.entries()) {
      defaults["include-in-header"] = [existingHeader];
      await injectPandocMathHeaders(defaults, profileDirectories[index], {
        mathJaxDirectory: path.join(directory, "mathjax"),
        macros,
        pandocDirectory: MACRO_TREE,
      });
    }

    const [reveal, latex, plain] = profiles;
    const revealHeaders = reveal["include-in-header"] as string[];
    const latexHeaders = latex["include-in-header"] as string[];

    assert.strictEqual(revealHeaders[0], existingHeader);
    assert.strictEqual(latexHeaders[0], existingHeader);
    assert.strictEqual(revealHeaders.length, 2);
    assert.strictEqual(latexHeaders.length, 2);
    assert.match(await readFile(revealHeaders[1], { encoding: "utf8" }), /window\.MathJax/);
    assert.match(
      await readFile(latexHeaders[1], { encoding: "utf8" }),
      /\\usepackage\[version=4\]\{mhchem\}/,
    );
    assert.deepStrictEqual(plain["include-in-header"], [existingHeader]);
  });

  it("runs real Pandoc TeX with the macro tree while preserving existing headers", async function () {
    this.timeout(60000);
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-pandoc-tex-"));
    const inputFile = path.join(directory, "input.md");
    const outputFile = path.join(directory, "output.tex");
    const defaultsFile = path.join(directory, "defaults.yaml");
    const existingHeader = path.join(directory, "existing.tex");
    const defaults = YAML.parse(
      await readFile("static/defaults/LaTeX.yaml", { encoding: "utf8" }),
    ) as Record<string, unknown>;
    defaults.standalone = true;
    defaults["input-files"] = [inputFile];
    defaults["output-file"] = outputFile;
    defaults["include-in-header"] = [existingHeader];

    await writeFile(inputFile, "$\\RR$ and $\\ce{H2O}$\n");
    await writeFile(existingHeader, "\\newcommand{\\Preserved}{yes}");
    await injectPandocMathHeaders(defaults, directory, {
      mathJaxDirectory: path.join(directory, "unused-mathjax"),
      macros,
      pandocDirectory: MACRO_TREE,
    });
    await writeFile(
      defaultsFile,
      Object.entries(defaults)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n"),
    );

    const tex = await runPandoc(defaultsFile, outputFile);

    assert.match(tex, /\\usepackage\[version=4\]\{mhchem\}/);
    // The definition of the macro tree, not of its MathJax projection.
    assert.match(tex, /\\newcommand\{\\RR\}\{\\mathbb\{R\}\}/);
    // The user's pre-existing include-header content is preserved verbatim.
    assert.match(tex, /\\newcommand\{\\Preserved\}\{yes\}/);
  });
});

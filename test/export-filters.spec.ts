import { pathToFileURL } from "node:url";
import assert from "assert";
import { execFile } from "child_process";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { writeDefaults } from "source/app/service-providers/commands/exporter/index";
import { promisify } from "util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);

// The ~/.pandoc directory of the export: its templates and its macro tree.
const MACRO_TREE = path.resolve("test", "fixtures", "pandoc-macros");
// The folder of the MathJax of the application. These specs write defaults
// and load no MathJax, so the folder has no file.
const MATHJAX_DIRECTORY = path.resolve(os.tmpdir(), "zettlr-export-mathjax");

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

describe("Declarative export filter chain", function () {
  it("prepends the declared filters before the profile filters and runs them", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-filters-"));
    const inputFile = path.join(directory, "input.md");
    const outputFile = path.join(directory, "output.tex");
    const markFilter = path.join(directory, "mark.lua");

    await writeFile(inputFile, "::: {.theorem}\nThis is a theorem.\n:::\n");
    await writeFile(
      markFilter,
      'function Div(el)\n  if el.classes[1] == "theorem" then\n    return pandoc.RawBlock("latex", "THEOREM_MARKER")\n  end\nend\n',
    );

    const latexProfile = YAML.parse(
      await readFile("static/defaults/LaTeX.yaml", { encoding: "utf8" }),
    ) as Record<string, unknown>;

    await writeDefaults(
      latexProfile,
      { "input-files": [inputFile], "output-file": outputFile, standalone: true },
      config,
      [markFilter], // the declared, ordered export filter chain
      directory,
      {
        mathJaxDirectory: MATHJAX_DIRECTORY,
        pandocDirectory: MACRO_TREE,
      },
    );

    // The written defaults must list the declared filter BEFORE the profile's
    // citeproc, not appended after it.
    const written = YAML.parse(
      await readFile(path.join(directory, "defaults.yml"), { encoding: "utf8" }),
    ) as { filters: unknown[] };
    assert.strictEqual(written.filters[0], markFilter);
    assert.ok(
      written.filters.some(
        (f) => typeof f === "object" && f !== null && (f as { type?: string }).type === "citeproc",
      ),
    );
    assert.ok(
      written.filters.indexOf(markFilter) <
        written.filters.findIndex(
          (f) => typeof f === "object" && (f as { type?: string })?.type === "citeproc",
        ),
    );

    // And the declared filter actually runs against real Pandoc.
    await execFileAsync("pandoc", ["--defaults", path.join(directory, "defaults.yml")]);
    const tex = await readFile(outputFile, { encoding: "utf8" });
    assert.match(tex, /THEOREM_MARKER/);
  });
});

describe("The math of an export", function () {
  async function writtenDefaults(profileFile: string): Promise<Record<string, unknown>> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-math-"));
    const inputFile = path.join(directory, "input.md");
    await writeFile(inputFile, "$\\RR$\n");
    const profile = YAML.parse(await readFile(profileFile, { encoding: "utf8" })) as Record<
      string,
      unknown
    >;
    await writeDefaults(
      profile,
      { "input-files": [inputFile], "output-file": path.join(directory, "out"), standalone: true },
      config,
      [],
      directory,
      { mathJaxDirectory: MATHJAX_DIRECTORY, pandocDirectory: MACRO_TREE },
    );
    return YAML.parse(
      await readFile(path.join(directory, "defaults.yml"), { encoding: "utf8" }),
    ) as Record<string, unknown>;
  }

  it("gives an HTML export the template of ~/.pandoc and the two places of MathJax, and no header", async function () {
    const written = await writtenDefaults("static/defaults/HTML.yaml");

    assert.equal(
      written.template,
      path.join(MACRO_TREE, "templates", "pandoc_preview_template.html"),
      "the template of ~/.pandoc for the writer owns the math",
    );
    assert.deepEqual(written["html-math-method"], {
      method: "mathjax",
      url: pathToFileURL(path.join(MATHJAX_DIRECTORY, "tex-chtml.js")).href,
    });
    assert.deepEqual(written.variables, {
      "mathjax-root": pathToFileURL(MATHJAX_DIRECTORY).href,
      "mathjax-fonts": pathToFileURL(path.join(MATHJAX_DIRECTORY, "fonts")).href,
    });
    assert.deepEqual(written["include-in-header"], [], "the application adds no header");
  });

  it("gives a reveal.js export the deck template of ~/.pandoc", async function () {
    const written = await writtenDefaults("static/defaults/Reveal.js.yaml");

    assert.equal(
      written.template,
      path.join(MACRO_TREE, "templates", "pandoc_revealjs_template.html"),
    );
    assert.deepEqual(written.variables, {
      "mathjax-root": pathToFileURL(MATHJAX_DIRECTORY).href,
      "mathjax-fonts": pathToFileURL(path.join(MATHJAX_DIRECTORY, "fonts")).href,
    });
  });

  it("gives a LaTeX export the template of ~/.pandoc, and no header and no MathJax", async function () {
    const profile = YAML.parse(
      await readFile("static/defaults/LaTeX.yaml", { encoding: "utf8" }),
    ) as Record<string, unknown>;
    const written = await writtenDefaults("static/defaults/LaTeX.yaml");

    assert.equal(written.template, path.join(MACRO_TREE, "templates", "research_draft.tex"));
    assert.deepEqual(written["include-in-header"], profile["include-in-header"]);
    assert.deepEqual(written["html-math-method"], profile["html-math-method"]);
    assert.deepEqual(written.variables, profile.variables);
  });

  it("stops an export whose template of ~/.pandoc is no file, and names the file", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-math-"));
    const emptyPandocDirectory = path.join(directory, "pandoc");
    const profile = YAML.parse(
      await readFile("static/defaults/HTML.yaml", { encoding: "utf8" }),
    ) as Record<string, unknown>;

    await assert.rejects(
      writeDefaults(
        profile,
        { "input-files": [], "output-file": path.join(directory, "out.html") },
        config,
        [],
        directory,
        { mathJaxDirectory: MATHJAX_DIRECTORY, pandocDirectory: emptyPandocDirectory },
      ),
      (error: Error) =>
        error.message.includes(
          path.join(emptyPandocDirectory, "templates", "pandoc_preview_template.html"),
        ),
    );
  });
});

describe("Export template defaults", function () {
  async function writeHtml(
    directory: string,
    profileExtra: Record<string, unknown>,
    configExtra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const inputFile = path.join(directory, "input.md");
    await writeFile(inputFile, "# Hi\n");
    const htmlProfile = {
      ...(YAML.parse(await readFile("static/defaults/HTML.yaml", { encoding: "utf8" })) as Record<
        string,
        unknown
      >),
      ...profileExtra,
    };
    const cfg = {
      export: { ...config.export, ...configExtra },
      zkn: config.zkn,
    };
    await writeDefaults(
      htmlProfile,
      {
        "input-files": [inputFile],
        "output-file": path.join(directory, "out.html"),
        standalone: true,
      },
      cfg,
      [],
      directory,
      {
        mathJaxDirectory: MATHJAX_DIRECTORY,
        pandocDirectory: MACRO_TREE,
      },
    );
    return YAML.parse(
      await readFile(path.join(directory, "defaults.yml"), { encoding: "utf8" }),
    ) as Record<string, unknown>;
  }

  it("applies the configured per-writer template when the profile declares none", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-tmpl-"));
    const written = await writeHtml(directory, {}, { htmlTemplate: "my-template.html" });
    assert.strictEqual(written.template, "my-template.html");
  });

  it("does not override a template the profile already declares", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-tmpl2-"));
    const written = await writeHtml(
      directory,
      { template: "profile-owned.html" },
      { htmlTemplate: "config.html" },
    );
    assert.strictEqual(written.template, "profile-owned.html");
  });
});

import assert from "assert";
import { execFile } from "child_process";
import { chmod, mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { writeDefaults } from "source/app/service-providers/commands/exporter/index";
import { runScriptExport } from "source/app/service-providers/commands/exporter/script-exporter";
import type {
  ExporterAPI,
  ExporterOptions,
} from "source/app/service-providers/commands/exporter/types";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import type { MathJaxMacro } from "source/common/util/mathjax-config";
import { promisify } from "util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);

let macros: Record<string, MathJaxMacro>;
before(async function () {
  macros = await loadMathJaxMacros("test/fixtures/mathjax-macros.json");
});

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

describe("Pipeline-integrated export scripts", function () {
  it("runs the base Pandoc profile, then the script on the processed output", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-export-scripts-"));
    const inputFile = path.join(directory, "input.md");
    const scriptFile = path.join(directory, "transform.sh");

    await writeFile(inputFile, "# Hello\n\nWorld.\n");
    // The script receives the Pandoc-processed intermediate as $1 and the final
    // output path as $2. It copies the intermediate and appends a marker.
    await writeFile(scriptFile, '#!/bin/sh\ncp "$1" "$2"\nprintf "\\nSCRIPT_RAN\\n" >> "$2"\n');
    await chmod(scriptFile, 0o755);

    // A ctx like makeExport builds, wired to the real writeDefaults + pandoc.
    const ctx: ExporterAPI = {
      runPandoc: async (defaultsFile: string) => {
        await execFileAsync("pandoc", ["--defaults", defaultsFile]);
        return { code: 0, stdout: [], stderr: [] };
      },
      writeDefaults: async (profileName: string, overrides: Record<string, unknown> = {}) => {
        const profile = YAML.parse(
          await readFile(`static/defaults/${profileName}`, { encoding: "utf8" }),
        ) as Record<string, unknown>;
        return await writeDefaults(
          profile,
          overrides,
          config,
          [],
          directory,
          path.join(directory, "unused.js"),
          macros,
        );
      },
      listDefaults: async () => [
        { name: "LaTeX.yaml", reader: "markdown", writer: "latex", isInvalid: false },
      ],
    };

    const options: ExporterOptions = {
      profile: { name: "Marked TeX", reader: "markdown", writer: "script", isInvalid: false },
      sourceFiles: [{ name: "input.md", ext: ".md", path: inputFile }],
      targetDirectory: directory,
    };
    const script = {
      name: "Marked TeX",
      profile: "LaTeX.yaml",
      command: scriptFile,
      extension: "txt",
    };

    const output = await runScriptExport(options, [inputFile], ctx, script);

    assert.strictEqual(output.code, 0);
    assert.strictEqual(output.targetFile, path.join(directory, "input.txt"));
    const produced = await readFile(output.targetFile, { encoding: "utf8" });
    assert.match(produced, /Hello/, "carries the Pandoc-processed intermediate");
    assert.match(produced, /SCRIPT_RAN/, "the declared script ran on it");
  });
});

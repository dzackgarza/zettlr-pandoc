import path from "node:path";
import type { QuickTexCatalogue } from "@dts/common/quicktex";
import { describeOutcome, runProcess } from "@dzack/external-process/run-process";
import { z } from "zod";

/** The JSON the Lua exporter below prints; every field is always emitted. */
const quickTexExportSchema = z.object({
  prose: z.record(z.string(), z.string()),
  math: z.record(z.string(), z.string()),
  excludeChars: z.array(z.string()),
});

function vimQuote(value: string): string {
  return value.replaceAll("'", "''");
}

/** The script of a QuickTeX plugin checkout that defines the plugin. */
export function quickTexPluginScript(pluginDirectory: string): string {
  return path.join(pluginDirectory, "plugin", "quicktex.vim");
}

/**
 * Sources QuickTeX and the user's Vimscript in Neovim, then exports the two
 * dictionaries through Vim's own keytrans(). Zettlr never parses Vimscript.
 */
export async function loadQuickTex(
  configFile: string,
  pluginDirectory: string,
): Promise<QuickTexCatalogue> {
  const pluginScript = quickTexPluginScript(pluginDirectory);
  const lua = [
    "local function tx(t)",
    // vim.empty_dict() so an empty dictionary encodes as {} rather than [].
    "  local out = vim.empty_dict()",
    "  for k, v in pairs(t or {}) do",
    "    if type(v) == 'string' then out[k] = vim.fn.keytrans(v) end",
    "  end",
    "  return out",
    "end",
    "local data = { prose = tx(vim.g.quicktex_prose or {}), math = tx(vim.g.quicktex_math or {}), excludeChars = vim.g.quicktex_excludechar }",
    "print(vim.json.encode(data))",
  ].join(" ");

  const outcome = await runProcess({
    command: "nvim",
    args: [
      "--headless",
      "-u",
      "NONE",
      "-n",
      "-c",
      `execute 'set runtimepath+=' . fnameescape('${vimQuote(pluginDirectory)}')`,
      "-c",
      `execute 'source ' . fnameescape('${vimQuote(pluginScript)}')`,
      "-c",
      `execute 'source ' . fnameescape('${vimQuote(configFile)}')`,
      "-c",
      `lua ${lua}`,
      "-c",
      "qa!",
    ],
    env: process.env,
    timeLimitMs: "none",
    waitForGroup: false,
  });
  if (outcome.ended !== "exit" || outcome.code !== 0) {
    throw new Error(
      `Couldn't load QuickTeX definitions from ${configFile}: ${describeOutcome("nvim", outcome)}`,
    );
  }
  const { stdout, stderr } = outcome;

  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const json = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (json === undefined) {
    throw new Error(
      `Couldn't load QuickTeX definitions from ${configFile}.${stderr.trim() === "" ? "" : ` ${stderr.trim()}`}`,
    );
  }

  // plugin/quicktex.vim sets g:quicktex_excludechar when it is sourced, so
  // the export always carries it; a missing field is a broken plugin checkout.
  const parsed = quickTexExportSchema.parse(JSON.parse(json));
  return {
    prose: parsed.prose,
    math: parsed.math,
    excludeChars: parsed.excludeChars,
    sourceFile: configFile,
    problem: undefined,
  };
}
